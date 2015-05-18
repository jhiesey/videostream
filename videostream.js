var MP4Box = require('mp4box');

/**
 * Stream data from `file` into `video`.
 * `file` must be an object with a `length` property giving the file size in bytes,
 * and a `createReadStream(opts)` method that retunr a string and accepts opts.start
 * and opts.end to specify a byte range (inclusive) to fetch.
 * @param {File} file described above
 * @param {HTMLVideoElement} video
 * @param {Object} opts Options
 * @param {number=} opts.debugTrack Track to save for debugging. Defaults to -1 (none)
 */
module.exports = function (file, video, opts) {
	opts = opts || {};
	debugTrack = -1; //opts.debugTrack || -1;
	debugBuffers = [];

	video.addEventListener('error', function (event) {
		console.error(event);
		console.error(video.error);
	});

	video.addEventListener('waiting', function () {
		if (ready) {
			seek(video.currentTime);
		}
	});

	var mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest();
	});
	video.src = window.URL.createObjectURL(mediaSource);

	var mp4box = new MP4Box();
	mp4box.onError = function (e) {
		console.error('MP4Box error:', e);
		mediaSource.endOfStream('decode');
	};
	var ready = false;
	var tracks = {}; // keyed by track id
	mp4box.onReady = function (info) {
		console.log('MP4 info:', info);
		info.tracks.forEach(function (track) {
			var mime = 'video/mp4; codecs="' + track.codec + '"';
			if (MediaSource.isTypeSupported(mime)) { //} && mime.indexOf('avc1') !== -1) {
				var sourceBuffer = mediaSource.addSourceBuffer(mime);
				var trackEntry = {
					buffer: sourceBuffer,
					arrayBuffers: [],
					meta: track,
					ended: false
				};
				sourceBuffer.addEventListener('updateend', popBuffers.bind(null, trackEntry));
				sourceBuffer.addEventListener('error', console.log.bind(console));
				mp4box.setSegmentOptions(track.id, null, {
					nbSamples: 500
				});
				tracks[track.id] = trackEntry;
			}
		});

		var initSegs = mp4box.initializeSegmentation();
		initSegs.forEach(function (initSegment) {
			if (initSegment.id === debugTrack) {
				debugBuffers.push(initSegment.buffer);
				save('init-track-' + debugTrack + '.mp4', debugBuffers);
			}
			appendBuffer(tracks[initSegment.id], initSegment.buffer);
		});
		ready = true;
	};

	mp4box.onSegment = function (id, user, buffer, nextSample) {
		var track = tracks[id];
		if (id === debugTrack) {
			debugBuffers.push(buffer);
			// TODO: this condition is wrong for fragmented files
			if (nextSample === track.meta.nb_samples) {
				save('debug-track-' + id + '.mp4', debugBuffers);
				debugBuffers = [];
			}
		}
		// TODO: this condition is wrong for fragmented files
		appendBuffer(track, buffer, nextSample === track.meta.nb_samples);
	};

	var desiredIngestOffset = 0;
	var stream = null;
	// var downloadBusy = false;
	function makeRequest () {
		if (stream) {
			return;
		}
		// downloadBusy = true;
		var requestOffset = desiredIngestOffset;
		var opts = {
			start: requestOffset,
			end: Math.min(file.length - 1, requestOffset + 100000)
		};
		stream = file.createReadStream(opts);
		console.log('createReadStream', opts);
		stream.on('data', function (data) {
			var arrayBuffer = data.toArrayBuffer(); // TODO: avoid copy
			arrayBuffer.fileStart = requestOffset;
			requestOffset += arrayBuffer.byteLength;
			desiredIngestOffset = mp4box.appendBuffer(arrayBuffer);
		});
		stream.on('end', function () {
			console.log('stream ending');
			stream = null;
			// downloadBusy = false;
			if (requestOffset === file.length) {
				mp4box.flush();
			}
			if (desiredIngestOffset !== file.length) {
				makeRequest();
			}
		});
		stream.on('error', function (err) {
			console.error('Stream error:', err);
			mediaSource.endOfStream('network');
		});
	}

	function seek (seconds) {
		var seekResult = mp4box.seek(seconds, true);
		console.log('Seeking to time: ', seconds);
		desiredIngestOffset = seekResult.offset;
		console.log('Seeked file offset:', desiredIngestOffset);
		if (stream) {
			stream.destroy();
			stream = null;
		}
		makeRequest();
	}

	function appendBuffer (track, buffer, ended) {
		track.arrayBuffers.push({
			buffer: buffer,
			ended: ended || false
		});
		popBuffers(track);
	}

	function popBuffers (track) {
		updateEnded(); // set call endOfStream() if needed
		if (track.buffer.updating || track.arrayBuffers.length === 0) return;
		var buffer = track.arrayBuffers.shift();
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
		} catch (e) {
			console.error('SourceBuffer error: ', e);
			// TODO: what to do? for now try again later (if buffer space was the issue)
			track.arrayBuffers.unshift(buffer);
		}
		updateEnded();
	}

	function updateEnded () {
		if (mediaSource.readyState !== 'open') {
			return;
		}

		var ended = Object.keys(tracks).every(function (id) {
			var track = tracks[id];
			return track.ended && !track.buffer.updating;
		});

		if (ended) {
			mediaSource.endOfStream();
		}
	}
};

/**
  Saves an array of ArrayBuffers to the given filename.
  @param {string} filename Filename to save as.
  @param {Array.<ArrayBufferBuffer>}
  */
function save (filename, buffers) {
  var blob = new Blob(buffers);
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.setAttribute('href', url);
  a.setAttribute('download', filename);
  a.click();
  URL.revokeObjectURL(url);
};

