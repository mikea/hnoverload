// run debug: DEBUG=hnoverload:* npm start

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var _ = require('underscore');
var Rx = require('rx');
var rss = require('node-rss');

var routes = require('./routes/index');
var users = require('./routes/users');
var Firebase = require("firebase");
var RxFirebase = require("./shared/rxfirebase");
var Instrument = require("./shared/instrument");

var app = express();

var DEV = app.get('env') === 'development';

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/bower_components', express.static(path.join(__dirname, 'bower_components')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// app.use('/', routes);
app.use('/users', users);

app.get('/ping', function(req, res) {
    res.send('pong');
});

var hnfb = new RxFirebase(new Firebase("https://hacker-news.firebaseio.com/v0/"));

var firebaseURL = DEV ? "https://hnoverload-dev.firebaseio.com" : "https://sweltering-heat-9449.firebaseio.com";
var firebase = new Firebase(firebaseURL);
var rxfb = new RxFirebase(firebase);

var instrument = new Instrument("/mike/hnoverload", process.env.instrument_url);

app.get('/rss', function(req, res) {
    var feed = rss.createNewFeed('HN Overload', 'https://hnoverload.herokuapp.com/',
        'Daily Top 10 HackerNews Posts',
        '',
        'https://hnoverload.herokuapp.com/rss', {});

    res.set('Content-Type', 'application/rss+xml');
    instrument.increment("/get", {
        "url": "/rss"
    });
    rxfb.child("dates")
        .limitToLast(11)
        .once("value")
        .map(function(snapshot) {
            return snapshot.val();
        })
        .flatMap(function(dates) {
            return _.chain(dates).keys().reverse().value();
        })
        .skip(1) // skip today
        .flatMap(function(date) {
            return rxfb.child("story_by_date/" + date)
                .once("value")
                .flatMap(function(snapshot) {
                    var storiesMap = snapshot.val();
                    if (!storiesMap) {
                        return [];
                    }

                    var allStories = _.chain(storiesMap)
                        .keys()
                        .map(function(key) {
                            return storiesMap[key];
                        })
                        .filter(function(story) {
                            return !story.deleted;
                        })
                        .toArray()
                        .value();

                    var sortingFn = function(story) {
                        return -story.score;
                    };

                    return _.chain(allStories)
                        .sortBy(sortingFn)
                        .first(10)
                        .toArray()
                        .value();
                });
        })
        .forEach(
            function(item) {
                var hnlink = "https://news.ycombinator.com/item?id=" + item.id;
                var description = "<p>HN Score: " + item.score + "</p>" +
                    "<p>HN Comments: <a href=\"" + hnlink + "\">" + (item.descendants || 0) + "</a></p>";

                var item = {
                    title: item.title,
                    link: item.url || hnlink,
                    pubDate: new Date(item.time * 1000).toUTCString(),
                    description: description,
                    guid: hnlink,
                    "dc:creator": item.by
                };
                feed.items.push(item);
            },
            null,
            function() {
                res.send(rss.getFeedXML(feed));
            });

});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: app.get('env') === 'development' ? err : {}
    });
});

// Firebase.enableLogging(true);

function logError(error) {
    console.log("*** UNHANDLED ERROR", error);
}

function updateStory(storyId) {
    instrument.increment("/tasks", {
        "task": "updateStory"
    });

    return hnfb
        .child("item/" + storyId)
        .once("value")
        .map(function(snapshot) {
            if (!snapshot.exists()) {
                console.log("null story ", storyId);
                throw new Error("null story");
            }
            return snapshot.val();
        })
        .doOnNext(function(story) {
            if (!_.has(story, "time")) {
                instrument.increment("/errors", {
                    "error": "story-time-not-defined"
                });
                throw new Error("time is not defined");
            }

            var item_location = "story_by_date/" + new Date(story.time * 1000).toISOString().substring(0, 10) + "/" + storyId;

            if (_.has(story, "parent")) {
                instrument.increment("/events", {
                    "event": "ignore-child-story"
                });
                return;
            }

            if (_.has(story, "deleted") && story.deleted) {
                instrument.increment("/events", {
                    "event": "story-deleted"
                });
                firebase.child(item_location).remove();
                return;
            }

            firebase.child(item_location).set(story);

            // bump max item id  
            instrument.increment("/events", {
                "event": "story-update"
            });
            firebase.child("maxitem").transaction(function(currentValue) {
                currentValue = currentValue || storyId;
                return currentValue < storyId ? storyId : currentValue;
            });
        });
}

function scheduleTask(name, payload, fn) {
    firebase
        .child("tasks")
        .push({
            name: name,
            payload: payload,
            fn: fn.toString(),
        });
}

function executeTask(key, task) {
    instrument.increment("/tasks", {
        "task": task.name
    });

    Rx.Observable
        .just(task)
        .flatMap(function(task) {
            try {
                var payload = task.payload;
                var fn = eval("(" + task.fn + ")");
                var o = fn(payload);
                return o || Rx.Observable.empty();
            } catch (e) {
                return Rx.Observable.throw(e);
            }
        })
        .doOnCompleted(function() {
            firebase.child("tasks")
                .child(key)
                .remove();
        })
        .doOnError(function(e) {
            firebase.child("tasks")
                .child(key)
                .transaction(function(task) {
                    task.errors = (task.errors || 0) + 1;
                    task.last_error = "" + e;
                    task.last_attempt = new Date().getTime() / 1000;
                    return task;
                });
        })
        .onErrorResumeNext(Rx.Observable.empty())
        .subscribe();
}

rxfb.child("tasks")
    .on("child_added")
    .map(function(snapshot) {
        return [snapshot.key(), snapshot.val()];
    })
    .filter(function(tuple) {
        return !tuple[1].errors;
    })
    .forEach(function(tuple) {
        executeTask(tuple[0], tuple[1]);
    });

function retryErrorTasks() {
    console.log("retrying tasks");
    rxfb.child("tasks")
        .once("value")
        .flatMap(function(snapshot) {
            return _.pairs(snapshot.val());
        })
        // .map(function(snapshot) {
        //     return [snapshot.key(), snapshot.val()];
        // })
        .filter(function(tuple) {
            return tuple[1].errors && tuple[1].errors < 10;
        })
        .forEach(function(tuple) {
            executeTask(tuple[0], tuple[1]);
        });
}


function watchNewStories(minStoryId) {
    var lastStoryId = minStoryId;

    hnfb.child("maxitem")
        .on("value")
        .forEach(function(snapshot) {
            instrument.increment("/events", {
                "event": "maxitem.value"
            });
            var maxId = snapshot.val();
            console.log("new maxvalue: " + maxId);
            if (lastStoryId) {
                for (var i = lastStoryId + 1; i <= maxId; i++) {
                    setTimeout(function() {
                        scheduleTask("updateStory", {
                            id: i
                        }, function(payload) {
                            return updateStory(payload.id);
                        })
                    }, 1000 * 60    );
                }
            }
            lastStoryId = maxId;
        });
}

function updateDate(date) {
    instrument.increment("/tasks", {
        "task": "updateDate"
    });
    console.log("*** updating stories for " + date);
    firebase.child("dates/" + date).set(true);

    rxfb.child("story_by_date/" + date)
        .once("value")
        .filter(function(snapshot) {
            return snapshot.val();
        })
        .flatMap(function(snapshot) {
            return Object.keys(snapshot.val())
        })
        .forEach(function(id) {
            scheduleTask("updateStory", {
                id: id
            }, function(payload) {
                return updateStory(payload.id);
            })
        });
}

function updateDateRange(from, to) {
    var d = new Date();
    d.setHours(0, 0, 0);

    for (var i = 0; i < to; i++, d.setDate(d.getDate() - 1)) {
        if (i >= from) {
            updateDate(d.toISOString().substring(0, 10));
        }
    }
}

function every15min() {
    instrument.increment("/lifecycle", {
        "event": "cron15m"
    });
    console.log("*** every15min");
    updateDateRange(0, 1);
}

function every1hr() {
    instrument.increment("/lifecycle", {
        "event": "cron1h"
    });
    console.log("*** every1hr");
    updateDateRange(1, 7);
}

rxfb.child("maxitem")
    .once("value")
    .map(function(snapshot) {
        return snapshot.val()/* || 9700000*/;
    })
    .doOnError(logError)
    .subscribeOnNext(function(maxid) {
        console.log("watching stories from " + maxid);
        watchNewStories(maxid);
    });

setInterval(scheduleTask, 1000 * 60 * 1, "retryErrorTasks", {}, retryErrorTasks);
setInterval(scheduleTask, 1000 * 60 * 15, "every15min", {}, every15min);
setInterval(scheduleTask, 1000 * 60 * 60, "every1hr", {}, every1hr);
retryErrorTasks();

instrument.increment("/lifecycle", {
    "event": "start"
});

module.exports = app;

console.log("Application started with " + firebaseURL, "environment: " + app.get('env'));