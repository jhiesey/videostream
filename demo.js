var videostream = require('./videostream');
var WebTorrent = require('webtorrent');

// This demo uses WebTorrent (https://github.com/feross/webtorrent)
var client = new WebTorrent();
// This hash is for the file at http://mirrorblender.top-ix.org/movies/sintel-1024-surround.mp4
var infoHash = 'a54c3ee75cb901001e46da2072ed7bfde7a5374e';

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