// for dev purposes:
require('dotenv').config();
//
if (!process.env.clientId || !process.env.clientSecret || !process.env.PORT ||
    !process.env.mongoURI || !process.env.NINJA_ACCESS_KEY_ID || !process.env.NINJA_SECRET || !process.env.FRESHSERVICE_API ||
    !process.env.FRESHSERVICE_URI || !process.env.SlackChannel ) {
    console.log('Error: Specify clientId, clientSecret, mongoURI, NINJA_ACCESS_KEY_ID, NINJA_SECRET, FRESHSERVICE_API, FRESHSERVICE_URI, SlackChannel, and PORT in environment');
    process.exit(1);
}

var Botkit = require('botkit');
var mongoStorage = require('botkit-storage-mongo')({mongoUri: process.env.mongoURI});
var request = require('request');
var freshservice = require('./lib/freshservice');
var mongo = require('mongodb');
var moment = require('moment-timezone');

var NinjaAPI = {
    accessKeyID: process.env.NINJA_ACCESS_KEY_ID || '',
    secret: process.env.NINJA_SECRET || '',
    host: 'http://api.ninjarmm.com',
    ver: 'v1',
    customerDashboard: 'https://app.ninjarmm.com/#/customerDashboard/'
};
var ninjaConnection = require('ninja-rmm-api')(NinjaAPI);

var controller = Botkit.slackbot({
    storage: mongoStorage,
}).configureSlackApp(
    {
        clientId: process.env.clientId,
        clientSecret: process.env.clientSecret,
        scopes: ['bot', 'chat:write:bot', 'users:read']
    }
);

controller.setupWebserver(process.env.PORT,function(err,webserver) {
    controller.createWebhookEndpoints(controller.webserver);
    controller.createHomepageEndpoint(controller.webserver);
    controller.createOauthEndpoints(controller.webserver,function(err,req,res) {
        if (err) {
            res.status(500).send('ERROR: ' + err);
        } else {
            res.send('Success!');
        }
    });
});


controller.on('rtm_open',function(bot) {
    console.log('** The RTM api just connected!');

    // *** main shuriken code begins here ***

    // get latest alert from mongoDB to start off
    var ninjaReqAlerts = {
        method: 'GET',
        contentMd5: null,
        contentType: null,
        date: null,
        resource: null
    };
    mongo.connect(process.env.mongoURI, function(err, db) {
        if (err) {
            throw 'Could not connect to Mongo DB';
        }
        db.collection('alerts').findOne( { latestAlertDoc: 1 }, function(err, doc) {
            if (err) {
                throw err;
            }
            db.close();
            if (doc && doc.latestAlert <= 0 || !doc) {
                console.log('warning: ** Latest alert ID in MongoDB is bad. Setting to 0.');
                ninjaReqAlerts.resource = '/v1/alerts/since/0';
                return startShuriken();
            }
            ninjaReqAlerts.resource = '/v1/alerts/since/' + doc.latestAlert;
            return startShuriken();
        });
    });

    function startShuriken() {

        setInterval(function() { // check every 5 minutes (10s for dev) for new Ninja Alerts

            request(ninjaConnection.generateOptions(ninjaReqAlerts), function(err, response, data) {
                console.log('info: ** requesting latest alerts from Ninja API');
                if (err) {
                    throw err;
                }
                if (response.statusCode > 300) {
                    throw 'error: ** Did not get a good response from Ninja API server: '+ response.statusCode;
                }
                console.log('info: ** Received good response from Ninja API:', response.statusCode);

                var parsedAlerts = JSON.parse(data);
                if (parsedAlerts.length) {
                    var latestAlert = Math.max(...parsedAlerts.map(alert => +alert.id));
                    console.log('info: ** Latest alert ID from received data: %d', latestAlert);
                    mongo.connect(process.env.mongoURI, function(err, db) {
                        if (err) {
                            throw 'error: ** Could not connect to MongoDB to update latest alert';
                        }
                        console.log('info: ** Connected to MongoDB to update latest alert');
                        db.collection('alerts').updateOne( { latestAlertDoc: 1 }, { $set: { latestAlert: latestAlert } }, { upsert: true }, function(err, result) {
                            if (err) {
                                throw 'error: ** Connected to MongoDB but could not update record. Error: ' + err;
                            }
                            ninjaReqAlerts.resource = '/v1/alerts/since/' + latestAlert;
                            db.close();
                        } );
                    });
                    parsedAlerts.forEach(function(alert) {
                        var alertButtons = [
                            {
                                name: 'reset',
                                text: 'Reset Alert',
                                value: 'reset',
                                type: 'button'
                            },
                            {
                                name: 'ticket',
                                text: 'Create ticket',
                                value: 'ticket',
                                type: 'button'
                            }
                        ];
                        var alertMessage = {
                                channel: process.env.SlackChannel,
                                icon_emoji: ':shuriken:',
                                attachments: [
                                {
                                    fallback: `*ALERT for ${alert.device.display_name} at ${alert.customer.name}:*\n\n${alert.message}\nTimestamp: ${alert.timestamp}`,
                                    callback_id: alert.id,
                                    color: 'danger',
                                    title: `ALERT for ${alert.device.display_name} at ${alert.customer.name}`,
                                    title_link: NinjaAPI.customerDashboard + alert.customer.id + '/overview',
                                    text: alert.message,
                                    fields: [
                                        {
                                            title: 'Timestamp',
                                            value: !process.env.TZ ? alert.timestamp : moment.tz(alert.timestamp, 'ddd, DD MMM YYYY HH:mm:ss', 'Europe/London').clone().tz(process.env.TZ).format('llll'),
                                            short: true
                                        }
                                    ],
                                    actions: alert.can_reset ? alertButtons : [alertButtons[1]]
                                }
                            ]
                        };

                        bot.say(alertMessage, function(err, response) {
                            if (err || !response.ok) {
                                console.log(err || response);
                            }
                        })
                    })
                }
            });

        }, 300000);
    }
});

controller.on('interactive_message_callback', function(bot, message) {
    bot.api.users.info({user: message.user}, function(err, info){
        var buttonPresser = null;
        if (err) {
            console.log('error: ** could not get user name of button presser');
        } else {
            buttonPresser = info.user.name;
        }
        if (message.actions[0].value === 'reset') {
            var resetAlertReq = {
                method: 'DELETE',
                contentMd5: null,
                contentType: null,
                date: null,
                resource: '/v1/alerts/' + message.callback_id
            };
            request(ninjaConnection.generateOptions(resetAlertReq), function(err, response, body) {
                if (err || response.statusCode !== 204) {
                    console.log('error: ** Errors from Ninja Reset Alert:', err, '\nResponse code:', response.statusCode);
                }
                bot.replyInteractive(message, {
                    attachments: [
                        {
                            fallback: 'Alert reset',
                            title: message.original_message.attachments[0].title,
                            text: message.original_message.attachments[0].text,
                            color: 'good',
                            fields: message.original_message.attachments[0].fields.concat({
                                title: `Alert has been reset${buttonPresser ? ' by ' + buttonPresser : '!'}`
                            }),
                        }
                    ]
                });
            });
        } else if (message.actions[0].value === 'ticket') {
            var ticketObject = {
                helpdesk_ticket: {
                    description: message.original_message.attachments[0].text,
                    subject: message.original_message.attachments[0].title,
                    email: 'noreply@ninjarmm.com',
                    priority: 1,
                    status: 2,
                    source: 2,
                    ticket_type: 'Incident',
                }
            };
            var fs_host = process.env.FRESHSERVICE_URI;
            request(freshservice(fs_host, process.env.FRESHSERVICE_API, 'POST', '/helpdesk/tickets.json', ticketObject), function(err, res, body) {
                console.log('info: ** Sending new ticket request to FreshService');
                if (err) {
                    console.log('error: ** Ticket creation failed:', err);
                }
                console.log('info: ** Got this response from FreshService:', res.statusCode);
                if (typeof body === 'object' && body.status) {
                    bot.replyInteractive(message, {
                        attachments: [
                            {
                                fallback: 'Ticket created',
                                title: message.original_message.attachments[0].title,
                                text: message.original_message.attachments[0].text,
                                color: 'good',
                                fields: message.original_message.attachments[0].fields.concat({
                                    title: `Alert made into a ticket${buttonPresser ? ' by ' + buttonPresser : '!'}`,
                                    value: 'https://' + fs_host + '/helpdesk/tickets/' + body.item.helpdesk_ticket.display_id
                                }),
                            }
                        ]
                    });
                }

            })
        }
    });
});
// end of main shuriken code

controller.on('rtm_close',function(bot) {
    console.log('** The RTM api just closed');
    // you may want to attempt to re-open
});




// Botkit stuff below //

// just a simple way to make sure we don't
// connect to the RTM twice for the same team
var _bots = {};
function trackBot(bot) {
    _bots[bot.config.token] = bot;
}

controller.on('create_bot',function(bot,config) {

    if (_bots[bot.config.token]) {
        // already online! do nothing.
    } else {
        bot.startRTM(function(err) {

            if (!err) {
                trackBot(bot);
            }
        });
    }

});

controller.storage.teams.all(function(err,teams) {

    if (err) {
        throw new Error(err);
    }

    // connect all teams with bots up to slack!
    for (var t  in teams) {
        if (teams[t].bot) {
            controller.spawn(teams[t]).startRTM(function(err, bot) {
                if (err) {
                    console.log('Error connecting bot to Slack:',err);
                } else {
                    trackBot(bot);
                }
            });
        }
    }

});