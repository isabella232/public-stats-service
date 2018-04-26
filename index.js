const _ = require('lodash');
const bodyParser = require('body-parser');
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
const routingApi = new platformClient.RoutingApi();
const analyticsApi = new platformClient.AnalyticsApi();
const conversationsApi = new platformClient.ConversationsApi();
const notificationsApi = new platformClient.NotificationsApi();

const app = express();
app.use(express.static(path.join(__dirname, 'static')));
app.use(putCache);
app.use(bodyParser.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const cache = {};
const monitoredQueueIds = process.env.PURECLOUD_MONITORED_QUEUES.split(',');
let channel, pureCloudWebSocket;
let stats = {};


// Send queue stats on new connection
wss.on('connection', function connection(ws) {
	wslog.info('Connection opened');
	ws.send(JSON.stringify({ queueStats: stats }));
});



/* API Routes */

/**
 * Get stats for a given queue ID 
 * 
 * @route {GET} /api/stats/:queueId
 * @pathparam {string} queueId - The ID of the queue for which to retrieve stats
 * @queryparam {string[]} key - The type of stats to get. Values: ewt, observations
 * @queryparam {string} mediaType - (optional) When used with key=ewt, returns the EWT for the given media type. If not specififed, EWT is for the entire queue.
 * @returns {json} JSON object containing requested stats
 */
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
		res.status(500).send(err.message ? err.message : 'Internal Server Error');
		next();
	}
});

/**
 * Creates a callback
 * 
 * @route {POST} /api/callback
 * @body {json} queueId - Supports the same structure as the body for POST /api/v2/conversations/callbacks
 * @see https://developer.mypurecloud.com/api/rest/v2/conversations/index.html#postConversationsCallbacks
 * @returns {nothing} Returns 204 upon success
 */
app.post('/api/callback', (req, res, next) => {
	try {
		let knownProperties = [
			'scriptId',
			'queueId',
			'routingData',
			'routingData.queueId',
			'routingData.languageId',
			'routingData.priority',
			'routingData.skillIds',
			'routingData.preferredAgentIds',
			'callbackUserName',
			'callbackNumbers',
			'callbackScheduledTime',
			'countryCode',
			'data',
		];

		let reqBody = makeSafeObject(req.body, knownProperties);

		if (!reqBody.queueId && (!reqBody.routingData || !reqBody.routingData.queueId)) 
			return res.status(400).send('Missing required property: queueID');
		if (!reqBody.callbackNumbers) 
			return res.status(400).send('Missing required property: callbackNumbers');

		conversationsApi.postConversationsCallbacks(reqBody)
			.then((data) => {
				log.info('Callback created: ', data);
				res.sendStatus(204);
				next();
			})
			.catch((err) => {
				if (err.status === 400 && err.body.message) {
					res.status(400).send(err.body.message);
				} else {
					log.error(err);
					res.status(500).send(err.message ? err.message : 'Internal Server Error');
				}
				next();
			});
	} catch (err) {
		log.error(err);
		res.status(500).send(err.message ? err.message : 'Internal Server Error');
		next();
	}
});



// Log in to PureCloud, start express server, start websocket server, connect to PureCloud notifications
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



/* Local Functions */

// Sanatize object from request to prevent unknown properties
function makeSafeObject(dirty, properties) {
	let safe = {};
	properties.forEach((prop) => {
		let parts = prop.split('.');
		let source = dirty;
		let target = safe;
		for (let i=0; i < parts.length - 1; i++) {
			if (!source[parts[i]]) return; // Source doesn't have property
			if (!target[parts[i]]) target[parts[i]] = {};
			source = source[parts[i]];
			target = target[parts[i]];
		}
		if (!source[parts[parts.length-1]]) return; // Source doesn't have property
		target[parts[parts.length-1]] = source[parts[parts.length-1]];
	});
	return safe;
}

// Call PureCloud APIs to get EWT
function getEwt(queueId, mediaType) {
	const deferred = Q.defer();

	if (mediaType) {
		routingApi.getRoutingQueueMediatypeEstimatedwaittime(queueId, mediaType)
			.then((data) => {
				log.debug(data);
				if (data.results && data.results.length > 0)
					deferred.resolve(data.results[0].estimatedWaitTimeSeconds ? data.results[0].estimatedWaitTimeSeconds : -1);
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
					deferred.resolve(data.results[0].estimatedWaitTimeSeconds ? data.results[0].estimatedWaitTimeSeconds : -1);
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

// Call PureCloud APIs to get queue observations
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

// Find metric in queue observation data
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

// Serve response from cache, if found and not expired
function getCache(req, res, next) {
	try {
		// Let putCache know it can cache this request
		req.isCachable = true;

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


// Add response to cache
function putCache(req, res, next) {
	try {
		// Monkey patch res.send
		let oldSend = res.send;
		res.send = function(data) {
			// Only store if it's a new response and is cachable
			if (!res.isCachedResponse && req.isCachable) {
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

// Broadcast a message to all websocket clients
function broadcast(msg) {
	wss.clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(typeof msg === 'object' ? JSON.stringify(msg) : msg);
		}
	});
}

// Handle incoming notification from PureCloud
function handleNotification(data) {
	wslog.debug('PureCloud Notification: ', data);
	let notification = JSON.parse(data);
	let match = notification.topicName.match(/v2\.analytics\.queues\.(.{8}-.{4}-.{4}-.{4}-.{12})\.observations/);
	if (match) {
		wslog.debug(`Found queue ${match[1]}`);
		updateQueueData(notification.eventBody.group.queueId, notification.eventBody.group.mediaType, notification.eventBody.data[0].metrics);
	}
}

// Update cached stats with new queue data
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
