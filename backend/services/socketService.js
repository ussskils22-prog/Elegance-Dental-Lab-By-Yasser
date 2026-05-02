const { Server } = require('socket.io');
const { verifyToken } = require('../config/jwt');
const User = require('../models/User');

let io;
const userConnections = new Map(); // userId -> socket id

const setupSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.SOCKET_IO_CORS || 'http://localhost:4200',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware to verify token
  io.use(async (socket, next) => {
    try {
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

    // ════════════════════════════════════════════════
    // CASE EVENTS
    // ════════════════════════════════════════════════

    // Case created
    socket.on('case:created', (data) => {
      io.emit('case:created', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        patientName: data.patientName,
        createdBy: data.createdBy,
        timestamp: new Date(),
      });
    });

    // Case assigned
    socket.on('case:assigned', (data) => {
      io.emit('case:assigned', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        assignedTo: data.assignedTo,
        assignedToName: data.assignedToName,
        timestamp: new Date(),
      });
    });

    // Case reassigned
    socket.on('case:reassigned', (data) => {
      io.emit('case:reassigned', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        oldAssignee: data.oldAssignee,
        newAssignee: data.newAssignee,
        timestamp: new Date(),
      });
    });

    // Case moved to stage
    socket.on('case:moved-stage', (data) => {
      io.emit('case:moved-stage', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        oldStage: data.oldStage,
        newStage: data.newStage,
        timestamp: new Date(),
      });
    });

    // Case completed
    socket.on('case:completed', (data) => {
      io.emit('case:completed', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        completedBy: data.completedBy,
        timestamp: new Date(),
      });
    });

    // Case released
    socket.on('case:released', (data) => {
      io.emit('case:released', {
        caseId: data.caseId,
        caseNumber: data.caseNumber,
        releasedBy: data.releasedBy,
        timestamp: new Date(),
      });
    });

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
    // NOTIFICATION EVENTS
    // ════════════════════════════════════════════════

    // Send notification
    socket.on('notification:send', (data) => {
      if (data.targetAudience === 'all') {
        io.emit('notification:new', data);
      } else if (Array.isArray(data.targetUsers)) {
        data.targetUsers.forEach((userId) => {
          const targetSocket = userConnections.get(userId);
          if (targetSocket) {
            io.to(targetSocket).emit('notification:new', data);
          }
        });
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

module.exports = {
  setupSocket,
  getIO,
  emitToUser,
  emitToAll,
};
