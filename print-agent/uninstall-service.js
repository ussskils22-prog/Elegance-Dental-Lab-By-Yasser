/**

 * Uninstall / stop the LocalSystem Windows service.

 * Prefer install-as-user-task.bat for USB printers.

 */

const Service = require('node-windows').Service;

const path = require('path');



const svc = new Service({

  name: 'ElegancePrintAgent',

  script: path.join(__dirname, 'agent.js'),

  workingDirectory: __dirname,

});



svc.on('uninstall', () => {

  console.log('✅ Windows service ElegancePrintAgent removed.');

});



svc.on('alreadyuninstalled', () => {

  console.log('ℹ️  Service was not installed.');

});



svc.on('error', (err) => {

  console.error('❌', err);

});



svc.uninstall();


