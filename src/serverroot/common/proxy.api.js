/*
 * Copyright (c) 2014 Juniper Networks, Inc. All rights reserved.
 */

/**
  * @proxy.api.js
  *     - Very basic forward proxy implementation for Contrail WebUI
  */
var url         = require('url');
var http        = require('http');
var https       = require('https');
var configUtils = require('./config.utils');
var logutils    = require('../utils/log.utils');
var appErrors   = require('../errors/app.errors');
var util        = require('util');
var messages    = require('./messages');
var async       = require('async');
var commonUtils = require('../utils/common.utils');
var jsonPath    = require('JSONPath').eval;
var _           = require('underscore');
var configServerApi = require('./configServer.api');
var proxyHelper = require('./proxy.helper');
var global      = require('./global');
var nodeList     = {'hosts': {}, 'ips': {}};
var timeOutId    = null;
var proxyURLStr  = 'proxyURL';
var protocolList = ['http:', 'https:'];
/* Default allowed proxy ports per node */
var defVirtualRouterPorts   = [
    '8085', /* HttpPortAgent */
    '8102', /* HttpPortVRouterNodemgr */
];
var defControlNodePorts     = [
    '8083', /* HttpPortControl */
    '8092', /* HttpPortDns */
    '8101', /* HttpPortControlNodemgr */
]
var defAnalyticsNodePorts   = [
    '8081', /* OpServerPort */
    '8089', /* HttpPortCollector */
    '8090', /* HttpPortOpserver */
    '8091', /* HttpPortQueryEngine */
    '8104', /* HttpPortAnalyticsNodemgr */
];
var defConfigNodePorts      = [
    '5998', /* DiscoveryServerPort */
    '8082', /* ApiServerPort */
    '8084', /* HttpPortApiServer */
    '8087', /* HttpPortSchemaTransformer */
    '8088', /* HttpPortSvcMonitor */
    '8096', /* HttpPortDeviceManager */
    '8100', /* HttpPortConfigNodemgr */
];

function getAllowedProxyPortListByNodeType (nodeType)
{
    var config = configUtils.getConfig();
    switch (nodeType) {
    case global.label.VROUTER:
        nodePortsLabel = 'vrouter_node_ports';
        defPorts = defVirtualRouterPorts;
        break;
    case global.label.CONTROL_NODE:
        nodePortsLabel = 'control_node_ports';
        defPorts = defControlNodePorts;
        break;
    case global.label.OPS_API_SERVER:
    case global.label.OPSERVER:
        nodePortsLabel = 'analytics_node_ports';
        defPorts = defAnalyticsNodePorts;
        break;
    case global.label.API_SERVER:
    case global.label.VNCONFIG_API_SERVER:
        nodePortsLabel = 'config_node_ports';
        defPorts = defConfigNodePorts;
        break;
    }
    var portObjs = commonUtils.getValueByJsonPath(config, "proxy;" +
                                                  nodePortsLabel, {});
    var portList = [];
    for (var key in portObjs) {
        if ("object" == typeof portObjs[key]) {
            portList = portList.concat(_.values(portObjs[key]));
        } else {
            portList.push(portObjs[key]);
        }
    }
    return (portList.length > 0) ? portList : defPorts;
}

function sendProxyRequest (request, response, appData, options, userData)
{
    var reqParams = options.query;
    var proxyURL = reqParams.proxyURL;
    var addAuthInfo = false;
    var isIndexedPage = (null != reqParams['indexPage']) ? true : false;
    logutils.logger.debug("Proxy Forwarder: Original: " + request.url +
                          " Forwarded TO: " + JSON.stringify(options));
    var protocol = ((options.protocol == 'http:') ? http : https);
    if ((null != options.port) && (null != userData)) {
        addAuthInfo = userData.addAuthInfo;
    }
    if (true == addAuthInfo) {
        options.headers = configServerApi.configAppHeaders(options.headers,
                                                           appData);
    }
    var reqParamStr = reqParams[proxyURLStr];
    if (-1 != reqParamStr.indexOf('/documentation/')) {
        var lastSlashIdx = reqParamStr.lastIndexOf('/');
        reqParamStr = reqParamStr.substr(0, lastSlashIdx);
        var lastHtmlIdx = reqParams[proxyURLStr].lastIndexOf('.html');
        if (-1 != lastHtmlIdx) {
            var htmlFile = reqParams[proxyURLStr].substr(lastSlashIdx + 1, lastHtmlIdx);
        }
    }
    /* Get SSL options in case of https request */
    var sslOptions = proxyHelper.getSSLOptionsByProxyPort(request, options.port);
    if ((null != sslOptions) &&
        (global.PROTOCOL_HTTPS == sslOptions.authProtocol)) {
        try {
            options.cert = fs.readFileSync(sslOptions.cert);
        } catch(e) {
            logutils.logger.error("SSL Cert file read error:" +
                                  sslOptions.cert);
            options.cert = "";
        }
        try {
            options.key = fs.readFileSync(sslOptions.key);
        } catch(e) {
            logutils.logger.error("SSL Key file read error:" +
                                  sslOptions.key);
            options.key = "";
        }
        try {
            options.ca = fs.readFileSync(sslOptions.ca);
        } catch(e) {
            logutils.logger.error("SSL CA file read error:" +
                                  sslOptions.ca);
            options.ca = "";
        }
        options.rejectUnauthorized = sslOptions.strictSSL;
        options.protocol = "https:";
        protocol = https;
    }
    var rqst = protocol.request(options, function(res) {
        var body = '';
        res.on('end', function() {
            if (true == isIndexedPage) {
                /* Before sending the response back, modify the href */
                body =
                    body.replace(/a href="/g, 'a href="proxy?proxyURL=' +
                                 reqParams[proxyURLStr] + '/');
            } else if (-1 != request.url.indexOf('/documentation/messages')) {
                body = body.replace(/(a href=")|(a href=)/g, function($0) {
                    var index = {
                        'a href="': 'a href="proxy?proxyURL=' +
                                        reqParamStr + '/',
                        'a href=': 'a href=proxy?proxyURL=' +
                                        reqParamStr + '/'
                    }
                    return index[$0] != undefined ? index[$0] : $0;
                });
            } else if (-1 != request.url.indexOf('/documentation')) {
                /* Remove the last / and then replace it */
                body =
                    body.replace(/href="/g, 'href="proxy?proxyURL=' +
                                 reqParamStr + '/');
                body =
                    body.replace(/documentation\/#/g, 'documentation/' +
                                 htmlFile + '#');
                var importDir = "";
                var lastSlashIdx = reqParams[proxyURLStr].lastIndexOf('/');
                importDir = reqParams[proxyURLStr].substr(0, lastSlashIdx);
                body =
                    body.replace(/import url\("/g, 'import url\("' +
                                              'proxy?proxyURL=' + importDir +
                                              '/')
                body =
                    body.replace(/src="/g, 'src="proxy?proxyURL=' +
                                 reqParamStr + '/');
            } else if (true == addAuthInfo) {
                /* Api/OpServerPort needs to be handled differently */
                body = body.replace(/"href": "/g, '"href":"' + request.protocol
                        +'://'+ request.headers.host +'/proxy?proxyURL=');
                body = body.replace(/"parent_href": "/g, '"parent_href":"' + request.protocol
                        +'://'+ request.headers.host +'/proxy?proxyURL=');
            }
            response.end(body);
        });
        res.on('data', function(chunk) {
            body += chunk;
        });
    }).on('error', function(err) {
          logutils.logger.error(err.stack);
          var error =
            new appErrors.ConnectionError(util.format(messages.error.api_conn,
                                                      options.hostname + ':' +
                                                      options.port));
          response.send(global.HTTP_STATUS_INTERNAL_ERROR, error.message);
    });
    rqst.end();
}

function forwardProxyRequest (request, response, appData)
{
    var index = 0;
    var options = url.parse(request.url, true);
    var reqParams = options.query;
    var errStr = null;
    var config = configUtils.getConfig();

    var isProxyEnabled =
        ((null != config.proxy) && (null != config.proxy.enabled)) ?
        config.proxy.enabled : true;
    if (false == isProxyEnabled) {
        var error = new appErrors.RESTServerError('Proxy is disabled');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if ((null == reqParams) || (null == reqParams[proxyURLStr])) {
        var error = new appErrors.RESTServerError('proxyURL parameter not ' +
                                                  'found in forward proxy ' +
                                                  'request');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if (0 == reqParams[proxyURLStr].length) {
        /* Sanity Check */
        response.statusCode = global.HTTP_STATUS_INTERNAL_ERROR;
        response.write("Error: empty proxyURL provided");
        response.end();
        return;
    }
    var pathStr = '';
    var proxy = url.parse(reqParams[proxyURLStr], true);
    for (key in reqParams) {
        if (proxyURLStr == key) {
            continue;
        }
        if (index == 0) {
            pathStr += '?';
        } else {
            pathStr += '&';
        }
        pathStr += key + '=' + reqParams[key];
        index++;
    }
    options.headers = {
        accept: '*/*',
        'content-length': 0
    };
    options.path = proxy.path + pathStr;
    options.hostname = proxy.hostname;
    options.port = proxy.port;
    options.protocol = proxy.protocol;
    if (null == options.port) {
        errStr = 'Port not provided in proxy URL';
    }
    if (null == options.hostname) {
        errStr = 'hostname not provided in proxy URL';
    }
    if (-1 == protocolList.indexOf(options.protocol)) {
        errStr = 'Protocol not provided - provide http/https in proxy URL';
    }
    if (null != errStr) {
        response.send(global.HTTP_STATUS_INTERNAL_ERROR, errStr);
        return;
    }

    proxyHelper.validateProxyIpPort(request, options.hostname, options.port,
                                    function(errStr, userData) {
        if (null != errStr) {
            response.send(global.HTTP_STATUS_INTERNAL_ERROR, errStr);
            return;
        }
        sendProxyRequest(request, response, appData, options, userData);
    });
}

exports.forwardProxyRequest = forwardProxyRequest;
exports.getAllowedProxyPortListByNodeType = getAllowedProxyPortListByNodeType;

