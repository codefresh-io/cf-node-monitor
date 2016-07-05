'use strict';

var util = require('util');
var fs = require('fs');
var path = require('path');
var Docker = require('dockerode');
var request = require('request');
var Q = require('q');

var fromCallback = function (fn) {
    var deferred = Q.defer();
    fn(function (err, data) {
        if (err) {
            deferred.reject(err);
        }
        else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
};
var consul       = require('consul')({
    host: 'consul',
    port: '8500',
    promisify: fromCallback
});

class NodeMonitor {

    constructor(){
        this.consulUpdateInterval = 10000;
        this.certPath = path.join(__dirname, '..', 'certs');
        this.caCertFile = path.join(this.certPath, 'ca.pem');
        this.clientCertFile = path.join(this.certPath, 'cert.pem');
        this.clientCertKeyFile = path.join(this.certPath, 'key.pem');
    }

    getDockerSwarm(){
        var self = this;
        return consul.health.service({service: 'swarm-man', passing: true})
        .then(function(srv){
            if (!srv || srv.length === 0) {
                return Q.reject(new Error("swarm-man service is not available"));
            }
            var addr             = srv[0].Service.Address;
            var port             = srv[0].Service.Port;
            return Q.all(
                [Q.nfcall(fs.readFile, self.caCertFile, 'utf8'),
                    Q.nfcall(fs.readFile, self.clientCertFile, 'utf8'),
                    Q.nfcall(fs.readFile, self.clientCertKeyFile, 'utf8')])
            .spread(function (caCert, clientCert, clientCertKey) {
                var docker = new Docker({
                    host: addr,
                    port: port,
                    ca: caCert,
                    cert: clientCert,
                    key: clientCertKey
                });
                return Q.resolve(docker);
            })
        })
    }

    getSwarmStatus() {
        return this.getDockerSwarm()
        .then(docker => Q.ninvoke(docker, "info"))
        .then(function (swarmInfo) {

            // check if docker daemon is swarm
            if (!swarmInfo.ServerVersion || !swarmInfo.ServerVersion.match(/^swarm.*/)) {
                return Q.reject(new Error(util.format("server %s:%s is not swarm", docker.host, docker.port)));
            }

            //  Transpose docker.info into hash with node statuses
            var statusArr = swarmInfo.SystemStatus;
            if (!statusArr || !statusArr.length) {
                return Q.reject(new Error(util.format("Cannot get nodes SystemStatus from %s:%s", docker.host, docker.port)));
            }
            // Transform swarm docker.info node
            var swarmStatus = {};
            var erroredNodes = {};
            var i = 0;

            swarmStatus.NodesData = {};
            swarmStatus.Fails = [];
            var propertyPrefix = String.fromCharCode(32, 32, 9492, 32);
            do {
                //var node = {};
                if (!statusArr[i][0].startsWith(propertyPrefix) && statusArr[i + 1] && statusArr[i + 1][0] === propertyPrefix + "ID") {
                    var node = {
                        hostname: statusArr[i][0].trim(),
                        address: statusArr[i][1]
                    };
                    i++;
                    do {
                        var nodeProp = statusArr[i][0].split(propertyPrefix)[1];
                        if (nodeProp) {
                            node[nodeProp] = statusArr[i][1];
                            i++;
                        }
                    }
                    while (nodeProp && i < statusArr.length);
                    swarmStatus.NodesData[node.address] = node;
                    if (node.Error && node.Error !== "(none)" || node.Status !== "Healthy") {
                        swarmStatus.Fails.push({
                            address: node.address,
                            hostname: node.hostname,
                            Error: node.Error,
                            Status: node.Status
                        });
                    }
                }
                else {
                    swarmStatus[statusArr[i][0]] = statusArr[i][1];
                    i++;
                }
            }
            while (i < statusArr.length);

            return Q.resolve(swarmStatus);
        })
        .catch(err => Q.reject(err));
    }

    updateNodeStatuses() {
        var checkId = "service:docker-node";

        return Q.all([ this.getSwarmStatus(),
                       consul.health.service({service: 'docker-node'})])
        .spread(function (swarmStatus, nodeServices) {
            var consulNodeCheckUpdates = [];
            for (var i=0; i<nodeServices.length; i++) {
                var s = nodeServices[i];
                var checkStatusSwarm, checkStatusConsul, checkOutputSwarm, checkOutputConsul;

                // Parse current service status from consul
                if (s.Checks) {
                    var nodeCheckArr = s.Checks.filter(c => c.CheckID === checkId);
                    if (nodeCheckArr.length > 0) {
                        checkStatusConsul = nodeCheckArr[0].Status;
                        checkOutputConsul = nodeCheckArr[0].Output;
                    }
                }

                // Parse current node status from swarm
                var nodeRef = util.format('%s:%s', s.Service.Address, s.Service.Port);
                if (!swarmStatus.NodesData || !swarmStatus.NodesData[nodeRef]) {
                    checkStatusSwarm = 'failing';
                    checkOutputSwarm = 'The node is not in the swarm cluster';
                }
                else {
                    var swarmNode = swarmStatus.NodesData[nodeRef];
                    if (swarmNode.Error && swarmNode.Error !== "(none)" || swarmNode.Status !== "Healthy") {
                        checkStatusSwarm = 'failing';
                        checkOutputSwarm = swarmNode.Error;
                    }
                    else {
                        checkStatusSwarm = 'passing';
                        checkOutputSwarm = "";
                    }
                }

                if (checkStatusSwarm !== checkStatusConsul || checkOutputSwarm !== checkOutputConsul) {
                    var consulNodeCheck = {
                        Node: s.Node.Node,
                        Address: s.Node.Address,
                        Check: {
                            Node: s.Node.Node,
                            ServiceID: s.Service.ID,
                            CheckID: checkId,
                            Name: "Docker Node Check",
                            Notes: "Docker Node Check - cf-node-monitor",
                            Status: checkStatusSwarm,
                            Output: checkOutputSwarm
                        }
                    }
                    consulNodeCheckUpdates.push(consulNodeCheck);
                    console.log(util.format("Updating consul - %s - %s: %s - %s", nodeRef, s.Node.Node, checkStatusSwarm, checkOutputSwarm));
                }
            }
            return Q.resolve(consulNodeCheckUpdates);
        })
        .then(function (consulNodeCheckUpdates) {
            if (consulNodeCheckUpdates.length === 0) {
                return Q.resolve();
            }
            else {
                return Q.all(consulNodeCheckUpdates.map(consulNodeCheck =>
                    Q.nfcall(request.put, {
                            headers: {'content-type': 'application/json'},
                            url: util.format('http://%s:%s/v1/catalog/register', consul._opts.host, consul._opts.port),
                            body: JSON.stringify(consulNodeCheck)
                        }
                    )));
            }
        })
        .then(function (consulResponse) {
            if (!consulResponse)
                return Q.resolve();
            else if (consulResponse.every(r => r[1] === "true")) {
                console.log("Node statuses has been updated in Consul\n");
                return Q.resolve();
            }
            else {
                return Q.reject(new Error(util.format("Failed to update Consul with node status: %s\n", consulResponse)));
            }
        })
        .catch(error => {
            console.log(error.stack + "\n" );
            }
            );
    }

    start(){
        console.log("Starting cf-node-monitor ...");
        setInterval(() => this.updateNodeStatuses(),  this.consulUpdateInterval);
    }
}
module.exports = new NodeMonitor();