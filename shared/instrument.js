'use strict';

(function(window){
    var isInNode = typeof module === 'object' && module && typeof module.exports === 'object';
    var Rx = isInNode ? require("rx") : window.Rx;
    var request = require('request');
    // require('request-debug')(request);
    
    var _ = require('underscore');

    var Instrument = function(prefix, endpointUrl) {
        this.prefix = prefix;
        this.subject = new Rx.Subject();
        
        console.info("instrument will use %s url", endpointUrl);
        
        // request.debug = true;
        
        this.subject
            .bufferWithTimeOrCount(10000, 1000)
            .filter(function (evts) { return evts.length; })
            .subscribe(function(evts) {
                if (endpointUrl) {
                    console.log("posting %d events", evts.length);
                    request.post(
                        {
                            url: endpointUrl, 
                            body: {events: evts}, 
                            json: true
                            , headers: {
                                "Content-Type" : "application/json"
                            }
                            
                        }, 
                        function (err, response, body) { 
                        if (err) {
                            console.error("error posting instrumentation", err);
                            return;
                        }
                        
                        if (response.statusCode != 200) {
                            console.error("error posting instrumentation", response.statusCode, body);
                            return;
                        }

                        console.log("posted %d events", evts.length);
                    });
                }
            })
    };
    
    Instrument.prototype.increment = function(name, fields) {
        var fieldsArray = _.chain(fields)
                           .keys()
                           .map(function (k) { 
                               var value = fields[k]
                               var valueKey = _.isNumber(value) ? "int32Value" : "stringValue";
                               var result = {name: k};
                               result[valueKey] = value;
                               return result;
                           })
                           .value();
        
        this.subject.onNext({
            name: this.prefix + name,
            fields: fieldsArray,
            value: 1,
            instant: new Date().getTime() / 1000,
            type: "DELTA"
        })
    }
    
    if (isInNode) { module.exports = Instrument; } else { window.Instrument = Instrument }  
})(this);