const admin = require('firebase-admin');
admin.initializeApp();

exports.onUserFirstReply = require('./chat/onUserFirstReply').onUserFirstReply;
exports.enforceChatTimeouts = require('./chat/enforceChatTimeouts').enforceChatTimeouts;
exports.requestFarewell = require('./chat/requestFarewell').requestFarewell;

exports.computeWeeklyRecurrence = require('./unlock/computeWeeklyRecurrence').computeWeeklyRecurrence;

exports.launchShiftCalendar = require('./shifts/launchShiftCalendar').launchShiftCalendar;
exports.toggleMyShift = require('./shifts/toggleMyShift').toggleMyShift;

exports.stripeWebhook = require('./payments/stripeWebhook').stripeWebhook;
exports.createCheckoutSession = require('./payments/createCheckoutSession').createCheckoutSession;

exports.createCompanion = require('./companions/createCompanion').createCompanion;
