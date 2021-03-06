var crypto = require('crypto');
var stream = require('stream');
var { IamAuthenticator, BasicAuthenticator } = require('ibm-watson/auth');
var DiscoveryV1 = require('ibm-watson/discovery/v1');

module.exports = function (RED) {
    function DiscoveryInsert(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        var options = {
            version: '2019-04-30',
            headers: {
                'X-Watson-Learning-Opt-Out': 'true'
            }
        };

        if (config.endpoint) {
            options.url = config.endpoint;
        }

        if (this.credentials.apikey) {
            options.authenticator = new IamAuthenticator({apikey: this.credentials.apikey});
        } else {
            options.authenticator = new BasicAuthenticator({username: this.credentials.username, password: this.credentials.password});
        }

        var discovery = new DiscoveryV1(options);
        var environment = config.environment;
        var collection = config.collection;

        var insert_queue = [];

        //allow for override of delay
        var delay = (config.delay !== 0) ? parseInt(config.delay) : 1000;
        var max_Q_size = (config.max_Q_size !== 0) ? parseInt(config.max_Q_size) : 10000;

        //update Q size once per second.
        var status_update_period = 750;

        //start Q
        var pq_to = setInterval(processQueue, delay);
        var up_to = setInterval(updateStatus, status_update_period, '');


        //START OFF FUNCTIONS
        function getSHA1(input) {
            return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex');
        }

        function sendToDiscoveryJSON(msg) {
            return new Promise(function (resolve, reject) {

                var env = (msg.hasOwnProperty('environment_id')) ? msg.environment_id : environment;
                var col = (msg.hasOwnProperty('collection_id')) ? msg.collection_id : collection;

                const string = JSON.stringify(msg.payload.content);
                const file = Buffer.from(string, 'utf8');
                const sha1 = getSHA1(string);
                const filename = msg.payload.filename || `${sha1}.json`;

                var document_obj = {
                    environmentId: env,
                    collectionId: col,
                    file: file,
                    filename: filename,
                    fileContentType: 'application/json',
                };

                return discovery.addDocument(document_obj).then((response) => {
                    resolve(response);
                }).catch((err) => {
                    if (err.code === 429) {
                        resolve(429);
                    } else {
                        reject(err);
                    }
                });
            });
        }

        function sendToDiscoveryBIN(msg) {
            return new Promise(function (resolve, reject) {

                var env = (msg.hasOwnProperty('environment_id')) ? msg.environment_id : environment;
                var col = (msg.hasOwnProperty('collection_id')) ? msg.collection_id : collection;

                var document_obj = {
                    environmentId: env,
                    collectionId: col,
                    file: msg.payload.content,
                    filename: msg.payload.filename,
                    fileContentType: msg.payload.file_content_type || undefined,
                };

                discovery.addDocument(document_obj).then((response) => {
                    resolve(response);
                }).catch((err) => {
                    if (err.code === 429) {
                        resolve(429);
                    } else {
                        reject(err);
                    }
                });
            });
        }

        function processQueue() {
            if (insert_queue.length !== 0) {
                var msg = insert_queue.pop();
                addToDiscovery(msg);
            }
        }

        function updateStatus() {
            var size = insert_queue.length;
            if (size !== 0) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "Queue Size: " + size
                });
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "Queue empty"
                });
            }
        }


        function addToDiscovery(msg) {
            var send = sendToDiscoveryJSON;

            if (msg.payload.content instanceof Buffer || msg.payload.content instanceof stream.Readable) {
                send = sendToDiscoveryBIN;
            }

            send(msg).then(function (response) {
                if (response !== 429) {
                    msg.payload = response;
                    msg.q_size = insert_queue.length;
                    node.send(msg);
                } else if (response === 429) {
                    addToQueue(msg);
                }
            }).catch(function (err) {
                if (("" + err).includes("ECONNREFUSED")) {
                    addToQueue(msg);
                } else {
                    node.error("" + err);
                }
            });
        }

        function addToQueue(msg) {
            if (insert_queue.length <= max_Q_size) {
                insert_queue.push(msg);
            } else {
                node.error("Queue Full, dropping Message");
            }
        }

        node.on('input', function (msg) {
            addToDiscovery(msg);
        });

        this.on('close', function () {
            // tidy up any
            clearInterval(pq_to);
            clearInterval(up_to);
        });
    }


    RED.nodes.registerType("discovery-insert", DiscoveryInsert, {
        credentials: {
            username: {
                type: "text"
            },
            password: {
                type: "password"
            },
            apikey: {
                type: "password"
            }
        }
    });
};
