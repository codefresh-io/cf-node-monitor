/**
 * Default config file for local env - to be replaces by configuration manager
 */
path = require('path');
var certPath = path.join(__dirname, '..', 'certs');

var config = {
    consul: {
        host: 'consul',
        port: '8500',
        aclToken: ''
    },
    tls: {
        certPath: path.join(__dirname, '..', 'certs'),
        caCertFile: path.join(certPath, 'ca.pem'),
        clientCertFile: path.join(certPath, 'cert.pem'),
        clientCertKeyFile: path.join(certPath, 'key.pem')
    },
    serviceName: 'node-monitor',
    servicePort: '3999',
    checkId: "service:docker-node",
    consulUpdateInterval: 10000,
    swarmPath: 'development-docker',
    debugLevel: process.env.DEBUG_LEVEL || 'info'
};

module.exports = config;
