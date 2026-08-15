const admin = require('firebase-admin');
admin.initializeApp();

exports.onUserFirstReply = require('./chat/onUserFirstReply').onUserFirstReply;
exports.enforceChatTimeouts = require('./chat/enforceChatTimeouts').enforceChatTimeouts;
exports.requestFarewell = require('./chat/requestFarewell').requestFarewell;

exports.computeWeeklyRecurrence = require('./unlock/computeWeeklyRecurrence').computeWeeklyRecurrence;

exports.launchShiftCalendar = require('./shifts/launchShiftCalendar').launchShiftCalendar;
exports.toggleMyShift = require('./shifts/toggleMyShift').toggleMyShift;

exports.createCheckoutSession = require('./payments/createCheckoutSession').createCheckoutSession;
exports.getCheckoutInfo = require('./payments/getCheckoutInfo').getCheckoutInfo;
exports.confirmCulqiCharge = require('./payments/confirmCulqiCharge').confirmCulqiCharge;

exports.createCompanion = require('./companions/createCompanion').createCompanion;
