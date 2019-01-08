const http = require('http')
const stream = require('readable-stream')
const VideoStream = require('../')

// This demo requires sintel.mp4 to be copied into the example directory
// Also, a reasonably recent browser that allows cancelling fetch or XHR requests is necessary

class file {
  constructor (path) {
    this.path = path
  }

  createReadStream (opts = {}) {
    const start = opts.start || 0
    const str = new stream.PassThrough()
    http.get({
      path: this.path,
      headers: {
        range: `bytes=${start}-`
      }
    }, res => {
      res.pipe(str)
    })
    return str
  }
}

const video = document.querySelector('video')
video.addEventListener('error', err => {
  console.error(video.error)
})
new VideoStream(new file('sintel.mp4'), video)

/*
const WebTorrent = require('webtorrent')

// This demo uses WebTorrent (https://webtorrent.io)
const client = new WebTorrent()

// Sintel torrent from webtorrent.io (https://webtorrent.io/torrents/sintel.torrent)
const torrentUrl = 'https://webtorrent.io/torrents/sintel.torrent'

client.add(torrentUrl, torrent => {
  // Got torrent metadata!
  console.log('Torrent info hash:', torrent.infoHash)
  // Let's say the fifth file is a mp4 (h264) video...
  new VideoStream(torrent.files[5], document.querySelector('video'))
})
*/
