// run debug: DEBUG=hnoverload:* npm start

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var _ = require('underscore');

var routes = require('./routes/index');
var users = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/bower_components', express.static(path.join(__dirname, 'bower_components')));

// app.use('/', routes);
app.use('/users', users);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});


var Firebase = require("firebase");
// Firebase.enableLogging(true);

var hnFirebase = new Firebase("https://hacker-news.firebaseio.com/v0/")
var firebase = new Firebase("https://sweltering-heat-9449.firebaseio.com")

function updateStory(storyId) {
  hnFirebase.child("item/" + storyId).once("value", function(itemSnapshot) {
      console.log("updating story " + storyId);

      story = itemSnapshot.val();
      if (!story) {
        console.log("Null story. Scheduling retry: " + storyId);
        setTimeout(updateStory, 10000, storyId);
        return;
      }
      if (!_.has(story, "time")) {
        console.log("Time is not defined: %j", story);
        setTimeout(updateStory, 10009, storyId);
        return;
      }

      var item_location = "story_by_date/" + new Date(story.time * 1000).toISOString().substring(0, 10) + "/" + storyId;
      firebase.child(item_location).set(story);
  });
}

hnFirebase.child("newstories").on("value", function(snapshot) {
    _.each(snapshot.val(), function(idx) {
        console.log("new id: " + idx);
        setTimeout(updateStory, 1000, idx);
    });
});



module.exports = app;
