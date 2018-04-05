/* globals ININ, pureCloudChatConfig, pureCloudCustomChatConfig:true */

let pureCloudWebchat, 
	pureCloudStatDataWebSocket, 
	pureCloudStatData;
let pureCloudChatStarted = false;

// This must be done as soon as possible for chat reconnect feature. Do not wait till document ready.
// https://developer.mypurecloud.com/api/webchat/ 
window.PURECLOUD_WEBCHAT_FRAME_CONFIG = pureCloudCustomChatConfig.containerEl;
ININ.webchat.create(pureCloudChatConfig, function(err, wc) {
	if (err) {
		console.error(err);
		throw err;
	}

	// Store reference so we can start the chat on a button click
	pureCloudWebchat = wc;

	// Auto (re)connect?
	if (pureCloudCustomChatConfig.autoConnect === true || wc.data.config.data.reconnectData) pureCloudRenderWidget('chat');
});

// function getStats() {
// 	$.get(`/api/stats/${customChatConfig.queueId}?key=ewt&mediaType=chat&key=observations`)
// 		.then((data) => {
// 			$('#availableAgents').text(data.observations.availableAgents);
// 			setTimeout(getStats, 500);
// 		})
// 		.catch((err) => {
// 			console.log(err);
// 		});
// }



$(document).ready(() => {
	pureCloudInitialize();

	// Register start chat button click handler
	$('#purecloud-chatwidget-header').click(() => {
		if (pureCloudChatStarted) return;

		// Update header
		pureCloudBuildHeader(pureCloudCustomChatConfig.header.activeText);

		// Render the chat window
		pureCloudRenderWidget('preview');
	});

	// Connect to stats websocket
	pureCloudConnectStatsNotifications();

	// Initialize UI
	$('#purecloud-chatwidget').css({
		'background-color': pureCloudCustomChatConfig.chatWidget.backgroundColor,
		'color': pureCloudCustomChatConfig.chatWidget.color
	});
	pureCloudBuildHeader(pureCloudCustomChatConfig.header.defaultText);
});



function pureCloudInitialize() {
	// Load main components
	$('head').append(`<link rel="stylesheet" type="text/css" href="${pureCloudCustomChatConfig.scriptHost}style/widget.css">`);
	$('body').append($('<div id="purecloud-chatwidget"><div id="purecloud-chatwidget-header"></div><div id="purecloud-chatwidget-container"><div id="purecloud-chatwidget-preview-container"></div><div id="purecloud-chatwidget-chat-container"></div><div id="purecloud-chatwidget-callback-container"></div></div></div>'));

	// Add in preview content
	let preview = $('<div>');

	// Agents available
	preview.append($('<div class="purecloud-chatwidget-row"><div class="purecloud-chatwidget-column-100"><p>There are currently <span id="purecloud-chatwidget-chatagents">0</span> agents available</p></div></div>'));

	// Preview tiles
	let contentRow = $('<div class="purecloud-chatwidget-row">');
	contentRow.append($('<div class="purecloud-chatwidget-column-50">')
		.append($('<div id="purecloud-chatwidget-dochat" class="purecloud-chatwidget-column-cell">')
			// .append('<img class="purecloud-chatwidget-centerimage" src="/img/chat.png" />')
			.append(`<img class="purecloud-chatwidget-centerimage" src="${pureCloudCustomChatConfig.scriptHost}img/chat.svg" />`)
			.append($('<p>').text('Chat with an expert'))
		)
	);
	contentRow.append($('<div class="purecloud-chatwidget-column-50">')
		.append($('<div id="purecloud-chatwidget-docallback" class="purecloud-chatwidget-column-cell">')
			// .append('<img class="purecloud-chatwidget-centerimage" src="/img/callback.png" />')
			.append(`<img class="purecloud-chatwidget-centerimage" src="${pureCloudCustomChatConfig.scriptHost}img/callback.svg" />`)
			.append($('<p>').text('Let us call you back when we\'re available'))
		)
	);
	preview.append(contentRow);
	$('#purecloud-chatwidget-preview-container').html(preview);

	$('#purecloud-chatwidget-dochat').click(() => {
		pureCloudRenderWidget('chat');
	});

	$('#purecloud-chatwidget-docallback').click(() => {
		pureCloudRenderWidget('callback');
	});


	let defaults = {
		autoConnect: false,
		chatWidget: {
			width: 450,
			height: 500,
			backgroundColor: '#4498B4',
			color: '#F6F6F6'
		},
		expandAnimationMs: 800,
		header: {
			defaultText: 'Click here to chat',
			activeText: 'Chatting with PureCloud',
			previewText: 'Choose a channel',
			logo: 'https://www.genesys.com/favicon/2017/favicon.ico'
		}
	};

	// Set custom config defaults
	if (pureCloudCustomChatConfig) {
		// Check required params
		if (!pureCloudCustomChatConfig.queueId) throw Error('Missing pureCloudCustomChatConfig.queueId');
		if (!pureCloudCustomChatConfig.statsWebsocketUri) throw Error('Missing pureCloudCustomChatConfig.statsWebsocketUri');
		if (!pureCloudCustomChatConfig.containerEl) throw Error('Missing pureCloudCustomChatConfig.containerEl');

		// Ensure all properties are set with something
		pureCloudSetDefaults(defaults, pureCloudCustomChatConfig);
	} else {
		pureCloudCustomChatConfig = defaults;
	}
}

function pureCloudSetDefaults(defaults, target) {
	Object.keys(defaults).forEach((key) => {
		if (typeof(defaults[key]) === 'object') {
			if (!target[key]) target[key] = {};
			pureCloudSetDefaults(defaults[key], target[key]);
		} else {
			if (!target[key]) target[key] = defaults[key];
		}
	});
}

function pureCloudBuildHeader(text) {
	$('#purecloud-chatwidget-header').css('cursor', 'default');
	let headerText = $('<span>');
	if (pureCloudCustomChatConfig.header.logo)
		headerText.append($('<img>').attr({ 
			src: pureCloudCustomChatConfig.header.logo,
			class: 'purecloud-chatwidget-header-image'
		}));
	headerText.append($('<span>').text(text));
	$('#purecloud-chatwidget-header').empty().append(headerText);
}

function pureCloudRenderWidget(mode = 'closed') {
	let d = pureCloudCustomChatConfig.expandAnimationMs; // full speed
	let d2 = d / 2; // half speed
	let d3 = d2 + 100; // half speed + delay

	// Stop and clear any pending animations on the elements
	$('#purecloud-chatwidget-chat-container').stop(true, false);
	$('#purecloud-chatwidget-callback-container').stop(true, false);
	$('#purecloud-chatwidget-preview-container').stop(true, false);
	$('#purecloud-chatwidget').stop(true, false);

	switch(mode) {
		case 'closed': {
			$('#purecloud-chatwidget').animate({ 
				height: 'auto', 
				width: 200 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$('#purecloud-chatwidget-chat-container').fadeOut(d2);
			$('#purecloud-chatwidget-callback-container').fadeOut(d2);
			$('#purecloud-chatwidget-preview-container').fadeOut(d2);
			break;
		}
		case 'preview': {
			$('#purecloud-chatwidget').animate({ 
				height: 257, 
				width: 350 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$('#purecloud-chatwidget-chat-container').fadeOut(d2);
			$('#purecloud-chatwidget-callback-container').fadeOut(d2);
			setTimeout(() => $('#purecloud-chatwidget-preview-container').fadeIn(d), d3);
			break;
		}
		case 'chat': {
			pureCloudStartChat();
			$('#purecloud-chatwidget').animate({ 
				height: pureCloudCustomChatConfig.chatWidget.height, 
				width: pureCloudCustomChatConfig.chatWidget.height 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$('#purecloud-chatwidget-preview-container').fadeOut(d2);
			$('#purecloud-chatwidget-callback-container').fadeOut(d2);
			setTimeout(() => $('#purecloud-chatwidget-chat-container').fadeIn(d), d3);
			break;
		}
		case 'callback': {
			$('#purecloud-chatwidget').animate({ 
				height: pureCloudCustomChatConfig.chatWidget.height, 
				width: pureCloudCustomChatConfig.chatWidget.height 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$('#purecloud-chatwidget-preview-container').fadeOut(d2);
			$('#purecloud-chatwidget-chat-container').fadeOut(d2);
			setTimeout(() => $('#purecloud-chatwidget-callback-container').fadeIn(d), d3);
			break;
		}
		default: {
			console.log(`Error: unknown mode ${mode}`);
		}
	}
}

function pureCloudStartChat() {
	if (pureCloudChatStarted) return;

	// Start/reconnect the chat
	pureCloudWebchat.renderFrame({
		containerEl: pureCloudCustomChatConfig.containerEl
	});
	pureCloudChatStarted = true;
}

function pureCloudConnectStatsNotifications() {
	// Create websocket to public stats service
	pureCloudStatDataWebSocket = new WebSocket(pureCloudCustomChatConfig.statsWebsocketUri);

	// Register event callbacks for websocket
	pureCloudStatDataWebSocket.onopen = (evt) => {
		console.log('stats-service::onopen', evt);
		// console.log(evt);
	};
	pureCloudStatDataWebSocket.onclose = (evt) => {
		console.log('stats-service::onclose', evt);
		// console.log(evt);
	};
	pureCloudStatDataWebSocket.onmessage = (evt) => {
		console.log('stats-service::onmessage', evt.data ? evt.data : evt);
		pureCloudStatData = JSON.parse(evt.data);
		if (pureCloudStatData.queueStats && pureCloudStatData.queueStats[pureCloudCustomChatConfig.queueId]) {
			$('#purecloud-chatwidget-chatagents').text(pureCloudStatData.queueStats[pureCloudCustomChatConfig.queueId].availableAgents);
		} else {
			console.log('unexpected message: ', pureCloudStatData);
		}
	};
	pureCloudStatDataWebSocket.onerror = (evt) => {
		console.log('stats-service::onerror', evt);
		// console.log(evt);
	};
}