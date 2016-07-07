var express = require('express');
// var bodyParser = require('body-parser');
//app.use(bodyParser.json());

var nodeMonitor = require('./NodeMonitor');
var config = require('./config');

var app = express();
var router  = express.Router();
app.use('/', router);


router.get('/', function(req, res) {
    //getDockerInfo().then( dockerInfo => res.send(dockerInfo) );
    nodeMonitor.getSwarmStatus().done( swarmStatus => res.send(swarmStatus), err => res.status(400).send(err.toString())  );
});

nodeMonitor.start();

app.listen(config.servicePort);

