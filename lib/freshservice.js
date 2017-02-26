/**
 * Created by petersquicciarini on 2/23/17.
 */

// https://domain.freshservice.com/path/to/api.json
var url = require('url');

module.exports = function(host, apiKey, method, resource, data) {
    return {
        url: url.resolve('https://' + host + '/', resource),
        method: method,
        auth: {
            user: apiKey,
            pass: 'dummy'
        },
        body: data || '',
        json: true
    };
};