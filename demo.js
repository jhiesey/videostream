var videostream = require('./videostream');
var WebTorrent = require('webtorrent');

// This demo uses WebTorrent (https://webtorrent.io)
var client = new WebTorrent();

// Sintel torrent from webtorrent.io (https://webtorrent.io/torrents/sintel.torrent)
var infoHash = '6a9759bffd5c0af65319979fb7832189f4f3c35d';

client.add({
	infoHash: infoHash,
	announce: 'wss://tracker.webtorrent.io/'
}, function (torrent) {
	// Got torrent metadata!
	console.log('Torrent info hash:', torrent.infoHash);
	// Let's say the first file is a mp4 (h264) video...
	videostream(torrent.files[0], document.querySelector('video'));
	var v = document.querySelector('video');
	v.play();
});
