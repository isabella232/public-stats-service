/* globals pureCloudCustomChatConfig */

pureCloudInjectChatScriptElement();

function pureCloudInjectChatScriptElement() {
	// If jquery isn't loaded, inject it and call this function again after it is
	if (typeof $ === 'undefined') {
		let jquery = document.createElement('script');
		jquery.src = 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js';
		jquery.onload = pureCloudInjectChatScriptElement;
		document.getElementsByTagName('head')[0].appendChild(jquery);
		return;
	}

	// If webchat API script isn't loaded, inject it and call this function again after it is
	if (typeof ININ === 'undefined') {
		let webchatApi = document.createElement('script');
		webchatApi.src = 'https://apps.mypurecloud.com/webchat/jsapi-v1.js';
		webchatApi.onload = pureCloudInjectChatScriptElement;
		document.getElementsByTagName('head')[0].appendChild(webchatApi);
		return;
	}

	if (!pureCloudCustomChatConfig.scriptHost.endsWith('/'))
		pureCloudCustomChatConfig.scriptHost += '/';

	// Inject chat widget script
	let chatScript = document.createElement('script');
	chatScript.src = `${pureCloudCustomChatConfig.scriptHost}scripts/chat-widget.js`;
	document.getElementsByTagName('head')[0].appendChild(chatScript);
}