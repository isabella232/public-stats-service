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
	// This line of code will automatically open the chat window on pageload if the chat can be reconnected
	if (pureCloudCustomChatConfig.autoConnect === true || wc.data.config.data.reconnectData) pureCloudRenderWidget('chat');
});


// Start once DOM is ready
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



// Injects widget into UI and initializes content
function pureCloudInitialize() {
	// Load main components
	$('head').append(`<link rel="stylesheet" type="text/css" href="${pureCloudCustomChatConfig.scriptHost}style/widget.css">`);
	$('body').append($(`<div id="purecloud-chatwidget"><div id="purecloud-chatwidget-header"></div><div id="purecloud-chatwidget-container"><div id="purecloud-chatwidget-preview-container"></div><div id="${pureCloudCustomChatConfig.containerEl}"></div><div id="purecloud-chatwidget-callback-container"></div></div></div>`));

	// Add in preview content
	let preview = $('<div>');

	// Agents available
	preview.append($('<div class="purecloud-chatwidget-row"><div class="purecloud-chatwidget-column-100"><p>There are currently <span id="purecloud-chatwidget-chatagents">0</span> agents available</p></div></div>'));

	// Preview tiles
	let contentRow = $('<div class="purecloud-chatwidget-row">');
	contentRow.append($('<div class="purecloud-chatwidget-column-50">')
		.append($('<div id="purecloud-chatwidget-dochat" class="purecloud-chatwidget-column-cell">')
			.append(`<img class="purecloud-chatwidget-centerimage" src="${pureCloudCustomChatConfig.scriptHost}img/chat.svg" />`)
			.append($('<p>').text('Chat with an expert'))
		)
	);
	contentRow.append($('<div class="purecloud-chatwidget-column-50">')
		.append($('<div id="purecloud-chatwidget-docallback" class="purecloud-chatwidget-column-cell">')
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
		console.log('render callback');
		pureCloudRenderWidget('callback');
	});

	// Callback content
	$('#purecloud-chatwidget-callback-container').append('<div class="purecloud-chatwidget-row purecloud-chatwidget-margin8"><label for="purecloud-chatwidget-callback-firstname" class="purecloud-chatwidget-label">First name</label><input type="text" id="purecloud-chatwidget-callback-firstname" /></div>');
	$('#purecloud-chatwidget-callback-container').append('<div class="purecloud-chatwidget-row purecloud-chatwidget-margin8"><label for="purecloud-chatwidget-callback-lastname" class="purecloud-chatwidget-label">Last name</label><input type="text" id="purecloud-chatwidget-callback-lastname" /></div>');
	$('#purecloud-chatwidget-callback-container').append('<div class="purecloud-chatwidget-row purecloud-chatwidget-margin8"><label for="purecloud-chatwidget-callback-phonenumber" class="purecloud-chatwidget-label">Phone number</label><input type="tel" id="purecloud-chatwidget-callback-phonenumber" /></div>');
	$('#purecloud-chatwidget-callback-container').append('<div class="purecloud-chatwidget-row purecloud-chatwidget-margin8"><button id="purecloud-chatwidget-callback-submit">Request Callback</button></div>');
	$('#purecloud-chatwidget-callback-submit').click(() => {
		let body = {
			queueId: pureCloudCustomChatConfig.queueId,
			callbackNumbers: [ $('#purecloud-chatwidget-callback-phonenumber').val() ],
			callbackUserName: `${$('#purecloud-chatwidget-callback-firstname').val()} ${$('#purecloud-chatwidget-callback-lastname').val()}`
		};
		console.log(body);
		$.post({
			url: `${pureCloudCustomChatConfig.scriptHost}api/callback`,
			data: JSON.stringify(body),
			contentType: 'application/json'
		})
			.then((data) => {
				$('#purecloud-chatwidget-callback-container').html($('<p>').text('Callback requested!'));
			})
			.catch((err) => {
				console.log('err');
				$('#purecloud-chatwidget-callback-container').html('<p>Failed to schedule callback! Please try again.</p>');
			});
	});

	let defaults = {
		autoConnect: false,
		containerEl: 'purecloud-chatwidget-chat-container',
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

// Set default values on config object
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

// Generates the widget header with text
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

// Controls widget state
function pureCloudRenderWidget(mode = 'closed') {
	let d = pureCloudCustomChatConfig.expandAnimationMs; // full speed
	let d2 = d / 2; // half speed
	let d3 = d2 + 100; // half speed + delay

	// Stop and clear any pending animations on the elements
	$(`#${pureCloudCustomChatConfig.containerEl}`).stop(true, false);
	$('#purecloud-chatwidget-callback-container').stop(true, false);
	$('#purecloud-chatwidget-preview-container').stop(true, false);
	$('#purecloud-chatwidget').stop(true, false);

	switch(mode) {
		case 'closed': {
			$('#purecloud-chatwidget').animate({ 
				height: 'auto', 
				width: 200 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$(`#${pureCloudCustomChatConfig.containerEl}`).fadeOut(d2);
			$('#purecloud-chatwidget-callback-container').fadeOut(d2);
			$('#purecloud-chatwidget-preview-container').fadeOut(d2);
			break;
		}
		case 'preview': {
			$('#purecloud-chatwidget').animate({ 
				height: 257, 
				width: 350 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$(`#${pureCloudCustomChatConfig.containerEl}`).fadeOut(d2);
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
			setTimeout(() => $(`#${pureCloudCustomChatConfig.containerEl}`).fadeIn(d), d3);
			break;
		}
		case 'callback': {
			$('#purecloud-chatwidget').animate({ 
				height: 196, 
				width: 400 
			}, pureCloudCustomChatConfig.expandAnimationMs);
			$('#purecloud-chatwidget-preview-container').fadeOut(d2);
			$(`#${pureCloudCustomChatConfig.containerEl}`).fadeOut(d2);
			setTimeout(() => $('#purecloud-chatwidget-callback-container').fadeIn(d), d3);
			break;
		}
		default: {
			console.log(`Error: unknown mode ${mode}`);
		}
	}
}

// Initiates/reconnects a web chat with PureCloud
function pureCloudStartChat() {
	if (pureCloudChatStarted) return;

	// Start/reconnect the chat
	pureCloudWebchat.renderFrame({
		containerEl: pureCloudCustomChatConfig.containerEl
	});
	pureCloudChatStarted = true;
}

// Connect to stats service and handle real-time stat notifications
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
