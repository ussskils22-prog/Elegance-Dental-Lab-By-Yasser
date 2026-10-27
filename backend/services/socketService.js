const { Server } = require('socket.io');
const { verifyToken } = require('../config/jwt');
const User = require('../models/User');

let io;
const userConnections = new Map(); // userId -> socket id
/** socket.id -> { connectedAt: Date } for live Print Agents */
const printAgentConnections = new Map();

function broadcastPrintAgentStatus() {
  if (!io) return;
  const online = printAgentConnections.size > 0;
  let connectedAt = null;
  for (const row of printAgentConnections.values()) {
    if (!connectedAt || row.connectedAt < connectedAt) connectedAt = row.connectedAt;
  }
  io.emit('print:agent-status', {
    online,
    agentCount: printAgentConnections.size,
    connectedAt: connectedAt ? connectedAt.toISOString() : null,
  });
}

function getPrintAgentStatus() {
  let connectedAt = null;
  for (const row of printAgentConnections.values()) {
    if (!connectedAt || row.connectedAt < connectedAt) connectedAt = row.connectedAt;
  }
  return {
    online: printAgentConnections.size > 0,
    agentCount: printAgentConnections.size,
    connectedAt: connectedAt ? connectedAt.toISOString() : null,
  };
}

const setupSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (origin.endsWith('.vercel.app')) return callback(null, true);
        if (origin === 'http://localhost:4200' || origin === process.env.SOCKET_IO_CORS) {
          return callback(null, true);
        }
        return callback(null, true); // Allow all for socket to prevent disconnects on previews
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware to verify token OR print-agent secret
  io.use(async (socket, next) => {
    try {
      // Print Agent connects with agentSecret instead of JWT
      const agentSecret = socket.handshake.auth.agentSecret;
      if (agentSecret) {
        if (agentSecret === process.env.PRINT_AGENT_SECRET) {
          socket.isPrintAgent = true;
          // Capabilities declared by the agent ("sheet,receipt"). Old agents send none → sheets only.
          socket.agentCaps = parseCaps(socket.handshake.auth.caps);
          return next();
        }
        return next(new Error('Invalid agent secret'));
      }

      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('No token provided'));
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return next(new Error('Invalid token'));
      }

      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      next();
    } catch (error) {
      next(error);
    }
  });

  io.on('connection', async (socket) => {
    // ── Print Agent connection ──────────────────────────
    if (socket.isPrintAgent) {
      socket.join('print-agents');
      printAgentConnections.set(socket.id, { connectedAt: new Date(), caps: socket.agentCaps || [] });

      // Agent tells us when its receipt printer appears/disappears
      socket.on('print:agent-caps', (data) => {
        const row = printAgentConnections.get(socket.id);
        if (row) row.caps = parseCaps(data && data.caps);
      });
      console.log(
        `🖨️  Print Agent connected (${printAgentConnections.size} online) — joined print-agents room`
      );
      broadcastPrintAgentStatus();

      // Catch-up: only unclaimed / stale jobs (never actively claimed by another agent)
      (async () => {
        try {
          const PrintJob = require('../models/PrintJob');
          const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
          const canReceipt = (socket.agentCaps || []).includes('receipt');
          const pendingJobs = await PrintJob.find({
            paperConfirmed: { $ne: 'yes' },
            // Receipts only to agents with a receipt printer — never on the sheet printer
            ...(canReceipt ? {} : { 'printData.jobKind': { $ne: 'receipt' } }),
            $or: [
              { status: { $in: ['pending', 'failed'] } },
              { status: 'printing', claimedAt: { $lt: staleBefore } },
              { status: 'printing', claimedAt: null },
            ],
          }).sort({ createdAt: 1 });
          if (pendingJobs.length > 0) {
            console.log(`🖨️  Sending ${pendingJobs.length} pending print jobs to connected agent`);
            pendingJobs.forEach(job => {
              socket.emit('print:new-job', {
                jobId: job._id,
                printData: job.printData,
              });
            });
          }
        } catch (err) {
          console.error('Error fetching pending jobs on agent connection:', err);
        }
      })();

      socket.on('print:job-status', async (data) => {
        try {
          const { applyAgentJobStatus } = require('../controllers/printController');
          const result = await applyAgentJobStatus(data.jobId, data.status, data.error || '');
          if (!result.ok) {
            console.warn(`🖨️  Print Job ${data.jobId} status rejected: ${result.message}`);
            return;
          }
          if (result.skipped) {
            console.log(`🖨️  Print Job ${data.jobId} status ignored (${result.reason})`);
            return;
          }
          const job = result.job;
          console.log(`🖨️  Print Job ${data.jobId} status updated to: ${job.status}`);
          io.emit('print:job-status-updated', {
            jobId: job._id,
            status: job.status,
            paperConfirmed: job.paperConfirmed,
            errorMessage: job.errorMessage,
          });
        } catch (err) {
          console.error('Error updating print job status via socket:', err);
        }
      });

      socket.on('disconnect', () => {
        printAgentConnections.delete(socket.id);
        console.log(
          `🖨️  Print Agent disconnected (${printAgentConnections.size} still online)`
        );
        broadcastPrintAgentStatus();
      });
      return; // Don't run user-related logic for agents
    }

    // ── Regular user connection ─────────────────────────
    console.log(`User ${socket.userId} connected: ${socket.id}`);

    // Store user connection
    userConnections.set(socket.userId, socket.id);

    // Update user status to online
    try {
      await User.findByIdAndUpdate(socket.userId, {
        status: 'online',
        lastSeen: new Date(),
      });
    } catch (error) {
      console.error('Error updating user status:', error);
    }

    // Emit user online to all clients
    io.emit('user:status-changed', {
      userId: socket.userId,
      status: 'online',
    });

    // Case events are emitted by the API after the database write.
    // Clients must not rebroadcast them — that made every screen reload on a fake move.

    // ════════════════════════════════════════════════
    // USER EVENTS
    // ════════════════════════════════════════════════

    // User status changed
    socket.on('user:status-change', async (data) => {
      const { status } = data;

      if (!['online', 'offline', 'idle'].includes(status)) return;

      try {
        await User.findByIdAndUpdate(socket.userId, {
          status,
          lastSeen: new Date(),
        });

        io.emit('user:status-changed', {
          userId: socket.userId,
          status,
          lastSeen: new Date(),
        });
      } catch (error) {
        console.error('Error updating user status:', error);
      }
    });

    // ════════════════════════════════════════════════
    // DISCONNECT
    // ════════════════════════════════════════════════

    socket.on('disconnect', async () => {
      console.log(`User ${socket.userId} disconnected`);

      userConnections.delete(socket.userId);

      try {
        await User.findByIdAndUpdate(socket.userId, {
          status: 'offline',
          lastSeen: new Date(),
        });
      } catch (error) {
        console.error('Error updating user status on disconnect:', error);
      }

      io.emit('user:status-changed', {
        userId: socket.userId,
        status: 'offline',
        lastSeen: new Date(),
      });
    });
  });

  return io;
};

const getIO = () => io;

const emitToUser = (userId, event, data) => {
  const socketId = userConnections.get(userId);
  if (socketId && io) {
    io.to(socketId).emit(event, data);
  }
};

const emitToAll = (event, data) => {
  if (io) {
    io.emit(event, data);
  }
};

function parseCaps(raw) {
  return String(raw || '')
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
}

/**
 * Send a print job to exactly one agent (newest connection) — prevents double sheets.
 * Receipt jobs go only to an agent that declared a receipt printer; if none is online the
 * job stays pending and the capable agent picks it up on its next poll.
 */
const emitToOnePrintAgent = (event, data) => {
  if (!io) return;
  const isReceipt = String(data?.printData?.jobKind || '') === 'receipt';
  let targetId = null;
  let newest = null;
  for (const [sid, row] of printAgentConnections.entries()) {
    if (isReceipt && !(row.caps || []).includes('receipt')) continue;
    if (!newest || (row.connectedAt && row.connectedAt > newest)) {
      newest = row.connectedAt;
      targetId = sid;
    }
  }
  if (targetId) {
    io.to(targetId).emit(event, data);
    return;
  }
  if (isReceipt) {
    console.log('🧾 Receipt job queued — no agent with a receipt printer is online right now');
    return;
  }
  // Fallback if map empty but room has members
  io.to('print-agents').emit(event, data);
};

module.exports = {
  setupSocket,
  getIO,
  emitToUser,
  emitToAll,
  emitToOnePrintAgent,
  getPrintAgentStatus,
};
