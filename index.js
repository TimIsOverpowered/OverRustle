// load config
var jf = require("jsonfile");
var fs = require("fs");
var CONFIG = fs.existsSync('./config.json') ? jf.readFileSync('config.json') : {};

var express = require('express');
var favicon = require('serve-favicon');
var redis = require('redis');
var request = require('request');
var app = express();

var constants = require("./jsx/constants.js");

// server side react js
var browserify = require('browserify'),
    literalify = require('literalify'),
    React = require('react');

require('react/addons');

var REDIS_ADDRESS = process.env["REDIS_ADDRESS"] || '172.16.5.254'
try{
  if(process.env.REDISTOGO_URL){
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
    var redis_client = redis.createClient(rtg.port, rtg.hostname);

    redis_client.auth(rtg.auth.split(":")[1]);
  }else{
    var redis_client = redis.createClient('6379',REDIS_ADDRESS); //I was using the production redis server ripperino
  }

  redis_client.select(0); 

  //tests redis connection
  redis_client.on('connect', function() {
    console.log('Connected to redis!');
  });
}catch (e){
  // in case redis doesn't exist
  console.log(e)
}

var session = require('express-session');
var RedisStore = require('connect-redis')(session);

// TODO: change settings if we want to handle secure cookies explicitly
// https://github.com/expressjs/session#cookie-options
// if (app.get('env') === 'production') {
//   app.set('trust proxy', 1) // trust first proxy
//   sess.cookie.secure = true // serve secure cookies
// }
app.use(session({
  store: new RedisStore({
    "client": redis_client
  }),
  // cookie: { maxAge: 60000*60*24*30 }
  secret: 'keyboard cat'
}));

// test layout of how we should probably format redis users
redis_client.hmset(
  'user:iliedaboutcake', //changable user name
  'stream', '19949118', //stream set from their profile
  'service', 'ustream', //service set from their profile
  'id','30384275', //twitch user ID from OAuth
  'twitchuser', 'iliedaboutcake', //twitch username
  'allowchange', 0, //allows the user to change username if set to 1
  'lastseen', new Date().toISOString(), //keep track of last seen
  'lastip','127.0.0.1'); //IP address for banning and auditing

app.listen(process.env.PORT || 8001);

app.set('views',__dirname + '/views');
app.set('view engine', 'ejs');

//handle static content 
app.use("/css", express.static(__dirname + '/css'));
app.use("/js", express.static(__dirname + '/js'));
app.use("/img", express.static(__dirname + '/img'));
app.use("/html", express.static(__dirname + '/html'));
app.use("/fonts", express.static(__dirname + '/fonts'));
app.use(favicon(__dirname + '/public/favicon.ico'));


global.SERVICES = constants.SERVICES
global.SERVICE_NAMES = Object.keys(constants.SERVICES);

// This is our React component, shared by server and browser thanks to browserify
//////////////////
var App = React.createFactory(require('./js/App'))

var browserified_bundle = browserify()
    .require('./js/App')
    .transform({global: true}, literalify.configure({react: 'window.React'}))
function pipeBundleJS(res){
  browserified_bundle.bundle().pipe(res)
}

// end server side react js
app.get('/bundle.js', function (req, res) {
  console.log('getting js bundle')
  res.setHeader('Content-Type', 'text/javascript')
  pipeBundleJS(res)
})
/////////////////


// cache the stream list from the API
// so that the HTML we serve on first load is fresh
/////////////////

var json_streams = {}

function process_api (api_data) {
  var viewercount = api_data["viewercount"]
  var strims = api_data["streams"]

  var strim_list = []

  for ( var strim in strims ) {
    if ( Object.prototype.hasOwnProperty.call(strims, strim) ) {
      strim_list.push({
        strim: strim,
        viewercount: strims[strim],
        metadata: api_data.metadata[api_data.metaindex[strim]]
      })
    }
  }

  strim_list.sort(function(a,b) {
    // give LIVE streams more weight in sorting higher
    var amulti = 1;
    var bmulti = 1;
    if (amulti*a.viewercount < bmulti*b.viewercount)
       return 1;
    if (amulti*a.viewercount > bmulti*b.viewercount)
      return -1;
    return 0;
  })
  return strim_list
}

function getApiData(){
  console.log('getting new data...')
  request.get({json:true, uri:"http://api.overrustle.com/api"}, function (e, r, resp) {
    if(e)
      return error_callback(e)
    var json = resp
    // api_data.live = r.statusCode < 400 && json.hasOwnProperty('status') && json['status'] !== 404
    //handle the streams listing here
    json_streams = process_api(resp)
    console.log("got new data", json_streams.length,  "streams")
  })
}

getApiData()
var apiRefresher = setInterval(getApiData, 2000)


// For the Future:
// This will require a rewrite on the server side to implement correctly
// var socket = require('socket.io-client')('http://api.overrustle.com/streams');
// socket.on('connect', function(){
//   console.log("Connected SOCKET")
//   // we cannot infer this from the referrer because <------------ IMPORTANT
//   // there is no way to set a referrer with this client <-------- IMPORTANT
//   socket.emit("idle", {"/strims"})
// });
// socket.on('strims', function(api_data){
//   console.log(api_data)
// });
// socket.on('disconnect', function(){
//   console.log("DISCONNECTED SOCKET")
// });

////////////////////

app.get (['/', '/strims', '/streams'], function(req, res, next) {
  console.log("/, /strims")
  var props = {
    strim_list: json_streams
  }
  res.render("layout", {page: "streams", streams: json_streams, rendered_streams: React.renderToString(App(props))})
});

// backwards compatibility:
app.get ('/destinychat', function(req, res, next){
  // TODO: redirect to new-style URLS once the API is upgraded
  console.log("/destinychat?s=service&stream=stream")
  res.render("layout", {page: "service", stream: req.query.stream, service: req.query.s})
});

// WARNING: if you get an ADVANCED stream with hashbangs in the URL they won't get past the form
app.get ('/:service/:stream', function(req, res, next) {
  //handle normal streaming services here
  console.log("/service/channel")
  if (global.SERVICE_NAMES[req.params.service]) {
    res.render("layout", {page: "service", stream: req.params.stream, service: req.params.service})
  }else{
    next();
  }
});

app.get ('/:channel', function(request, response, next) {
  console.log("/channel", request.originalUrl)
  //handle the channel code here, look up the channel in redis
  redis_client.hgetall('user:' + request.params.channel.toLowerCase(), function(err, returned) {
    if (returned) {
      res.render("layout", {page: "index", stream: "Live Streams"})

      response.render("layout", {page: "service", stream: returned.stream, service: returned.service})
      //response.send(returned.stream + ' - ' + returned.service);
    } else {
      next();
    }
  });
});
app.post("/channel", function(req, res, next){

})

app.get ('/profile', function(request, response) {
  //handle profile stuff
});