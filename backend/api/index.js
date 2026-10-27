let app;
let bootError;
try {
  app = require('../server');
} catch (error) {
  bootError = error;
}

module.exports = function handler(req, res) {
  if (bootError) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      message: bootError.message || 'Boot failed',
    }));
    return;
  }
  try {
    return app(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      message: error.message || 'Request failed',
    }));
  }
};
