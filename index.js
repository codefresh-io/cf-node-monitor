var express = require('express');
// var bodyParser = require('body-parser');
var util = require('util');

var app = express();
var router  = express.Router();

var fs = require('fs');
var Docker = require('dockerode');
var request = require('request');
var Q = require('q');
//app.use(bodyParser.json());
app.use('/', router);

function getDockerInfo() {
    var nodeAddr = '23.251.147.109';
    var nodePort = "3376";
    var caCertFile = "/d1/codefresh/.secure/cf-ca/dev/ca.pem";
    var clientCertFile = "/d1/codefresh/.secure/cf-ca/dev/client-cert.pem";
    var clientCertKeyFile = "/d1/codefresh/.secure/cf-ca/dev/client-key.pem";

    return Q.all(
              [Q.nfcall(fs.readFile, caCertFile, 'utf8'),
               Q.nfcall(fs.readFile, clientCertFile, 'utf8'),
               Q.nfcall(fs.readFile, clientCertKeyFile, 'utf8')])
    .spread(function(caCert, clientCert, clientCertKey){
        var  docker = new Docker({
            host: nodeAddr,
            port: nodePort,
            ca: caCert,
            cert: clientCert,
            key: clientCertKey
        });
        return Q.resolve(docker);
    })
    .then(docker => Q.ninvoke(docker, "info"))
    .then(function(dockerInfo){

        // check if docker daemon is swarm
        if (! dockerInfo.ServerVersion || ! dockerInfo.ServerVersion.match(/^swarm.*/)) {
            return Q.reject(new Error(util.format("server %s:%s is not swarm", nodeAddr, nodePort)));
        }

        //  Transpose docker.info into hash with node statuses
        var statusArr = dockerInfo.SystemStatus;
        if (! statusArr || ! statusArr.length) {
            return Q.reject(new Error(util.format("Cannot get nodes SystemStatus from %s:%s", nodeAddr, nodePort)));
        }
        var systemStatus = {};
        var erroredNodes = {};
        var i = 0;
        // write swarm systemStatus until first node
        for(;i<statusArr.length; i++) {
            systemStatus[statusArr[i][0]] = statusArr[i][1];
            if (statusArr[i][0] === 'Nodes') break;
        }


        // Transform swarm docker.info node
        i++;
        systemStatus.NodesData = [];
        var propertyPrefix = String.fromCharCode(32,32,9492,32);
        do {
            var node = {};
            if (! statusArr[i][0].startsWith(propertyPrefix) && statusArr[i+1] && statusArr[i+1][0] === propertyPrefix + "ID"){
                node = {name: statusArr[i][0].trim(),
                          ip: statusArr[i][1]};
                i++;
                do {
                    var nodeProp = statusArr[i][0].split(propertyPrefix)[1];
                    if (nodeProp) {
                        node[nodeProp] = statusArr[i][1];
                        i++;
                    }
                }
                while(nodeProp && i < statusArr.length);
                systemStatus.NodesData.push(node);
            }
            else i++;

        }
        while (i < statusArr.length);

        return Q.resolve(systemStatus);
    })
    .catch(err => Q.reject(err));
}

router.get('/', function(req, res) {
   getDockerInfo().then( dockerInfo => res.send(dockerInfo) );
});



app.listen(3999);

