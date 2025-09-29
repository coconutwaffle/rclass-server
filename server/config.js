//config.js
const config = {
  domain: 'test.coconutwaffle.org',
  port: 7000,
  
  // DB
  db_host: '172.20.0.30',
  db_port: 5432,
  db_user: 'rclass_user',
  db_pass: 'rclass_pass',
  db_name: 'rclass',

  mediasoup: {
    // worker 공통
    rtcMinPort: 48000,
    rtcMaxPort: 48999,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],

    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: { 'x-google-start-bitrate': 1000 },
        },
      ],
    },
  },

  webRtcTransport: {
    listenIps: [
      { ip: '0.0.0.0', announcedIp: null }, // announcedIp will be set dynamically
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    preferTcp: false,
    initialAvailableOutgoingBitrate: 800000,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.coconutwaffle.org:49600', username: 'waffle', credential: 'waffle' },
      { urls: 'turns:turn.coconutwaffle.org:49610', username: 'waffle', credential: 'waffle' },
    ],
  },
};

export default config;