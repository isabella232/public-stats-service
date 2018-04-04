const _ = require('lodash');
const express = require('express');
const http = require('http');
const log = new (require('lognext'))('service');
const cachelog = new (require('lognext'))('cache');
const wslog = new (require('lognext'))('websocket');
const path = require('path');
const platformClient = require('purecloud-platform-client-v2');
const Q = require('q');
const WebSocket = require('ws');

const CACHE_SECONDS = process.env.CACHE_SECONDS || 2;
const PORT = process.env.PORT || 8080;
const PURECLOUD_CLIENT_ID = process.env.PURECLOUD_CLIENT_ID;
const PURECLOUD_CLIENT_SECRET = process.env.PURECLOUD_CLIENT_SECRET;

const client = platformClient.ApiClient.instance;
// client.setDebugLog(console.log, 25);
const routingApi = new platformClient.RoutingApi();
const analyticsApi = new platformClient.AnalyticsApi();
const notificationsApi = new platformClient.NotificationsApi();

const app = express();
app.use(express.static(path.join(__dirname, 'static')));
app.use(putCache);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const cache = {};
const monitoredQueueIds = [
	'db79e38d-25e8-40d5-8b17-3155bf5adc24'
];
let channel, pureCloudWebSocket;



wss.on('connection', function connection(ws) {
	wslog.info('Connection opened');
	ws.send(JSON.stringify({ queueStats: stats }));
});



app.get('/api/stats/:queueId', getCache, (req, res, next) => {
	log.debug(`Getting data for queue ${req.params.queueId}`);
	try {
		// Support comma separated values
		let keys = req.query.key;
		if (!Array.isArray(keys))
			keys = keys.split(',');

		let promises = [];
		let resBody = {};
		keys.forEach((key) => {
			switch (key) {
				case 'ewt': {
					let p = getEwt(req.params.queueId, req.query.mediaType);
					p
						.then((data) => {
							resBody.ewt = data;
						})
						.catch((err) => {
							log.error(err);
							res.status(500).send(err.message ? err.message : 'Internal Server Error');
							next();
						});
					promises.push(p);
					break;
				}
				case 'observations': {
					let p = getQueueObservations(req.params.queueId);
					p
						.then((data) => {
							// resBody.observations = data;
							resBody.observations = stats[req.params.queueId];
						})
						.catch((err) => {
							log.error(err);
							res.status(500).send(err.message ? err.message : 'Internal Server Error');
							next();
						});
					promises.push(p);
					break;
				}
				default: {
					res.sendStatus(400);
					next();
				}
			}
		});

		Promise.all(promises)
			.then(() => {
				res.json(resBody);
				next();
			})
			.catch((err) => {
				log.error(err);
				res.status(500).send(err.message ? err.message : 'Internal Server Error');
				next();
			});
	} catch (err) {
		log.error(err);
		next();
	}
});

client.loginClientCredentialsGrant(PURECLOUD_CLIENT_ID, PURECLOUD_CLIENT_SECRET)
	.then(() => {
		return notificationsApi.postNotificationsChannels();
	})
	.then((data) => {
		channel = data;

		// Connect web socket
		pureCloudWebSocket = new WebSocket(channel.connectUri);
		pureCloudWebSocket.on('open', () => {
			wslog.info('Connected to PureCloud');
		});

		pureCloudWebSocket.on('message', handleNotification);

		let topics = [];
		monitoredQueueIds.forEach((queueId) => {
			topics.push({ id: `v2.analytics.queues.${queueId}.observations`});
			getQueueObservations(queueId);
		});
		log.debug('Subscribing to topics: ', topics);
		return notificationsApi.putNotificationsChannelSubscriptions(channel.id, topics);
	})
	.then((data) => {
		server.listen(PORT, () => log.info(`Example app listening on port ${PORT}!`));
	})
	.catch((err) => log.error(err));



function getEwt(queueId, mediaType) {
	const deferred = Q.defer();

	if (mediaType) {
		routingApi.getRoutingQueueMediatypeEstimatedwaittime(queueId, mediaType)
			.then((data) => {
				log.debug(data);
				if (data.results && data.results.length > 0)
					deferred.resolve(data.results[0].estimatedWaitTimeSeconds);
				else
					deferred.resolve(0);
			})
			.catch((err) => {
				deferred.reject(err);
			});
	} else {
		routingApi.getRoutingQueueEstimatedwaittime(queueId)
			.then((data) => {
				log.debug(data);
				if (data.results && data.results.length > 0)
					deferred.resolve(data.results[0].estimatedWaitTimeSeconds);
				else
					deferred.resolve(0);
			})
			.catch((err) => {
				log.error(err);
				deferred.reject(err);
			});
	}

	return deferred.promise;
}

function getQueueObservations(queueId) {
	const deferred = Q.defer();

	const query = {
		filter: {
			type: 'and',
			predicates: [
				{
					type: 'dimension',
					dimension: 'queueId',
					operator: 'matches',
					value: queueId
				}
			]
		},
		metrics: [
			'oInteracting',
			'oOnQueueUsers',
			'oWaiting',
		]
	};

	analyticsApi.postAnalyticsQueuesObservationsQuery(query)
		.then((data) => {
			data.results.forEach((result) => {
				updateQueueData(result.group.queueId, result.group.mediaType, result.data);
			});

			deferred.resolve();
		})
		.catch((err) => {
			deferred.reject(err);
		});

	return deferred.promise;
}

function getQueueObservationMetric(data, metricName, qualifier, defaultValue) {
	let foundMetric;

	// Find metric
	data.some((metric) => {
		if (metric.metric === metricName && (!qualifier || metric.qualifier === qualifier)) {
			foundMetric = metric;
			return true;
		}
	});
	
	// Return
	return foundMetric ? foundMetric.stats.count : defaultValue;
}

function getCache(req, res, next) {
	try {
		let now = Date.now();
		// Load from cache if expiry later than now
		if (cache[req.url] && cache[req.url].expiryDate > now) {
			let msLeft = cache[req.url].expiryDate - now;
			cachelog.debug(`HIT ${req.url} (${msLeft/1000}s remaining)`);
			res.isCachedResponse = true;
			res.json(cache[req.url].body);
		} else {
			cachelog.debug(`MISS ${req.url}`);
			next();
		}
	} catch (err) {
		cachelog.error(err);
		next();
	}
}

function putCache(req, res, next) {
	try {
		// Monkey patch res.send
		let oldSend = res.send;
		res.send = function(data) {
			// Only store if it's a new response
			if (!res.isCachedResponse) {
				// Only store if it was a normal successful response
				if (res.statusCode === 200) {
					cachelog.debug(`ADD ${req.url}`);
					cache[req.url] = {
						url: req.url,
						expiryDate: Date.now() + (CACHE_SECONDS * 1000),
						body: JSON.parse(data)
					};
				}
			}
			oldSend.apply(res, arguments);
		};
	} catch (err) {
		cachelog.error(err);
	}
	next();
}

function broadcast(msg) {
	wss.clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(typeof msg === 'object' ? JSON.stringify(msg) : msg);
		}
	});
}

function handleNotification(data) {
	wslog.debug('PureCloud Notification: ', data);
	let notification = JSON.parse(data);
	let match = notification.topicName.match(/v2\.analytics\.queues\.(.{8}-.{4}-.{4}-.{4}-.{12})\.observations/);
	if (match) {
		wslog.debug(`Found queue ${match[1]}`);
		handleQueueObservationData(notification);
	}
}

let stats = {};

function handleQueueObservationData(data) {
	updateQueueData(data.eventBody.group.queueId, data.eventBody.group.mediaType, data.eventBody.data[0].metrics);
}

function updateQueueData(queueId, mediaType, metrics) {
	if (!stats[queueId]) stats[queueId] = { availableAgents: 0, busyAgents: 0 };

	if (!mediaType) {
		stats[queueId].availableAgents = getQueueObservationMetric(metrics, 'oOnQueueUsers', 'IDLE', stats[queueId].availableAgents ? stats[queueId].availableAgents : 0);
		stats[queueId].busyAgents = getQueueObservationMetric(metrics, 'oOnQueueUsers', 'INTERACTING', stats[queueId].busyAgents ? stats[queueId].busyAgents : 0);
	} else {
		if (!stats[queueId][mediaType]) stats[queueId][mediaType] = {};
		stats[queueId][mediaType].interacting = getQueueObservationMetric(metrics, 'oInteracting', undefined, stats[queueId][mediaType].interacting ? stats[queueId][mediaType].interacting : 0);
		stats[queueId][mediaType].waiting = getQueueObservationMetric(metrics, 'oWaiting', undefined, stats[queueId][mediaType].waiting ? stats[queueId][mediaType].waiting : 0);
	}
	// wslog.debug(stats);
	broadcast({ queueStats: stats });
}


