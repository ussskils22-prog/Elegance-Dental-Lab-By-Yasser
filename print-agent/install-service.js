/**
 * Install Print Agent as a Windows Service
 * Run once as Administrator: npm run install-service
 * Or: install-as-service.bat
 */
const Service = require('node-windows').Service;
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('❌ Missing config.json next to agent.js');
  process.exit(1);
}

const svc = new Service({
  name: 'ElegancePrintAgent',
  description: 'Elegance Dental Lab — Remote Print Agent (auto-start with Windows)',
  script: path.join(__dirname, 'agent.js'),
  workingDirectory: __dirname,
  nodeOptions: [],
  // Restart automatically if crashed / process killed
  grow: 0.25,
  wait: 2,
  maxRestarts: 100,
  maxRetries: 100,
});

svc.on('install', () => {
  svc.start();
  console.log('✅ Print Agent installed and started as Windows Service!');
  console.log('   Name: ElegancePrintAgent');
  console.log('   Manage: services.msc → ElegancePrintAgent');
  console.log('   Working dir:', __dirname);
});

svc.on('alreadyinstalled', () => {
  console.log('ℹ️  Service already installed. Starting…');
  svc.start();
});

svc.on('error', (err) => {
  console.error('❌ Service error:', err);
});

svc.install();
