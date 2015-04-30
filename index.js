
var videostream = require('./videostream');
var WebTorrent = require('webtorrent');

var client = new WebTorrent();
// var infoHash = '08cb0bb4adbe99973906352e11fd07daddc2ce22';
var infoHash = '5d3aaec17026f780af3224d98e47de9694029173';

client.add({
	infoHash: infoHash,
	announce: 'wss://tracker.webtorrent.io/'
}, function (torrent) {
	// Got torrent metadata!
	console.log('Torrent info hash:', torrent.infoHash);
	// Let's say the first file is a webm (vp8) or mp4 (h264) video...
	videostream(torrent.files[0], document.querySelector('video'));
	var v = document.querySelector('video');
	v.play();
	// window.setTimeout(function () {
	// 	if (v.readyState === 1) {
	// 		v.play();
	// 	}
	// }, 1000);
});