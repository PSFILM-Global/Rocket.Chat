import os from 'os';

import moment from 'moment';
import _ from 'underscore';
import { Meteor } from 'meteor/meteor';
import { InstanceStatus } from 'meteor/konecty:multiple-instances-status';

import {
	Sessions,
	Settings,
	Users,
	Rooms,
	Subscriptions,
	Uploads,
	Messages,
	LivechatVisitors,
	Integrations,
	Statistics,
	LivechatCustomField,
	LivechatDepartment,
	LivechatTrigger,
} from '../../../models/server';
import { settings } from '../../../settings/server';
import { Info, getMongoInfo } from '../../../utils/server';
import { Migrations } from '../../../migrations/server';
import { getStatistics as federationGetStatistics } from '../../../federation/server/functions/dashboard';
import { NotificationQueue, Users as UsersRaw, LivechatAgentActivity } from '../../../models/server/raw';
import { LivechatRooms } from '../../../models';
import { readSecondaryPreferred } from '../../../../server/database/readSecondaryPreferred';
import { getAppsStatistics } from './getAppsStatistics';
import { getStatistics as getEnterpriseStatistics } from '../../../../ee/app/license/server';
import { Team } from '../../../../server/sdk';

const wizardFields = [
	'Organization_Type',
	'Industry',
	'Size',
	'Country',
	'Language',
	'Server_Type',
	'Register_Server',
];

const getUserLanguages = (totalUsers) => {
	const result = Promise.await(UsersRaw.getUserLanguages());

	const languages = {
		none: totalUsers,
	};

	result.forEach(({ _id, total }) => {
		if (!_id) {
			return;
		}
		languages[_id] = total;
		languages.none -= total;
	});

	return languages;
};


export const statistics = {
	getKeyHavingMaxValue(map, def) {
		let maxValue = 0;
		let maxKey = def;	// default

		map.forEach((value, key) => {
			if (value > maxValue) {
				maxValue = value;
				maxKey = key;
			}
		});

		return maxKey;
	},
	get: async function _getStatistics() {
		const readPreference = readSecondaryPreferred(Uploads.model.rawDatabase());
		const totalMessagesOnWeekday = new Map();	// total messages on weekdays i.e Monday, Tuesday...
		let totalConversations = 0; // Total conversations
		let openConversations = 0; // open conversations
		let totalMessages = 0; // total msgs

		const today = moment(new Date());
		const start = moment(new Date(today.year(), today.month(), today.date(), 0, 0, 0));
		const end = moment(new Date(today.year(), today.month(), today.date(), 23, 59, 59));

		const summarize = (m) => ({ metrics, msgs }) => {
			if (metrics && !metrics.chatDuration) {
				openConversations++;
			}
			totalMessages += msgs;

			const weekday = m.format('dddd'); // @string: Monday, Tuesday ...
			totalMessagesOnWeekday.set(weekday, totalMessagesOnWeekday.has(weekday) ? totalMessagesOnWeekday.get(weekday) + msgs : msgs);
		};

		for (let m = moment(start); m.diff(end, 'days') <= 0; m.add(1, 'days')) {
			const date = {
				gte: m,
				lt: moment(m).add(1, 'days'),
			};

			const result = Promise.await(LivechatRooms.getAnalyticsBetweenDate(date).toArray());
			totalConversations += result.length;

			result.forEach(summarize(m));
		}

		const averageOfAvailableServiceTime = (await LivechatAgentActivity.findAllAverageAvailableServiceTime({
			date: parseInt(moment(new Date()).format('YYYYMMDD')),
			departmentId: null,
		}))[0];

		const statistics = {};

		// Setup Wizard
		statistics.wizard = {};
		wizardFields.forEach((field) => {
			const record = Settings.findOne(field);
			if (record) {
				const wizardField = field.replace(/_/g, '').replace(field[0], field[0].toLowerCase());
				statistics.wizard[wizardField] = record.value;
			}
		});

		// Version
		statistics.uniqueId = settings.get('uniqueID');
		if (Settings.findOne('uniqueID')) {
			statistics.installedAt = Settings.findOne('uniqueID').createdAt;
		}

		if (Info) {
			statistics.version = Info.version;
			statistics.tag = Info.tag;
			statistics.branch = Info.branch;
		}

		// User statistics
		statistics.totalUsers = Users.find().count();
		statistics.activeUsers = Users.getActiveLocalUserCount();
		statistics.activeGuests = Users.getActiveLocalGuestCount();
		statistics.nonActiveUsers = Users.find({ active: false }).count();
		statistics.appUsers = Users.find({ type: 'app' }).count();
		statistics.onlineUsers = Meteor.users.find({ status: 'online' }).count();
		statistics.awayUsers = Meteor.users.find({ status: 'away' }).count();
		statistics.busyUsers = Meteor.users.find({ status: 'busy' }).count();
		statistics.totalConnectedUsers = statistics.onlineUsers + statistics.awayUsers;
		statistics.offlineUsers = statistics.totalUsers - statistics.onlineUsers - statistics.awayUsers - statistics.busyUsers;
		statistics.userLanguages = getUserLanguages(statistics.totalUsers);

		// Room statistics
		statistics.totalRooms = Rooms.find().count();
		statistics.totalChannels = Rooms.findByType('c').count();
		statistics.totalPrivateGroups = Rooms.findByType('p').count();
		statistics.totalDirect = Rooms.findByType('d').count();
		statistics.totalLivechat = Rooms.findByType('l').count();
		statistics.totalDiscussions = Rooms.countDiscussions();
		statistics.totalThreads = Messages.countThreads();

		// Teams statistics
		statistics.teams = Promise.await(Team.getStatistics());

		// livechat visitors
		statistics.totalLivechatVisitors = LivechatVisitors.find().count();

		// livechat agents
		statistics.totalLivechatAgents = Users.findAgents().count();

		// livechat department
		statistics.totalLivechatDepartments = LivechatDepartment.find().count();

		// livechat enabled
		statistics.livechatEnabled = settings.get('Livechat_enabled');


		// livechat analytics
		statistics.busiestDay = this.getKeyHavingMaxValue(totalMessagesOnWeekday, '-');
		statistics.openConversations = openConversations;
		statistics.totalConversations = totalConversations;
		statistics.totalMessages = totalMessages;
		statistics.averageOfAvailableServiceTime = averageOfAvailableServiceTime;
		statistics.totalLivechatCustomFields = LivechatCustomField.find().count();
		statistics.totalLivechatTriggers = LivechatTrigger.find().count();


		// Message statistics
		statistics.totalChannelMessages = _.reduce(Rooms.findByType('c', { fields: { msgs: 1 } }).fetch(), function _countChannelMessages(num, room) { return num + room.msgs; }, 0);
		statistics.totalPrivateGroupMessages = _.reduce(Rooms.findByType('p', { fields: { msgs: 1 } }).fetch(), function _countPrivateGroupMessages(num, room) { return num + room.msgs; }, 0);
		statistics.totalDirectMessages = _.reduce(Rooms.findByType('d', { fields: { msgs: 1 } }).fetch(), function _countDirectMessages(num, room) { return num + room.msgs; }, 0);
		statistics.totalLivechatMessages = _.reduce(Rooms.findByType('l', { fields: { msgs: 1 } }).fetch(), function _countLivechatMessages(num, room) { return num + room.msgs; }, 0);
		statistics.totalMessages = statistics.totalChannelMessages + statistics.totalPrivateGroupMessages + statistics.totalDirectMessages + statistics.totalLivechatMessages;

		// Federation statistics
		const federationOverviewData = federationGetStatistics();

		statistics.federatedServers = federationOverviewData.numberOfServers;
		statistics.federatedUsers = federationOverviewData.numberOfFederatedUsers;

		statistics.lastLogin = Users.getLastLogin();
		statistics.lastMessageSentAt = Messages.getLastTimestamp();
		statistics.lastSeenSubscription = Subscriptions.getLastSeen();

		statistics.os = {
			type: os.type(),
			platform: os.platform(),
			arch: os.arch(),
			release: os.release(),
			uptime: os.uptime(),
			loadavg: os.loadavg(),
			totalmem: os.totalmem(),
			freemem: os.freemem(),
			cpus: os.cpus(),
		};

		statistics.process = {
			nodeVersion: process.version,
			pid: process.pid,
			uptime: process.uptime(),
		};

		statistics.deploy = {
			method: process.env.DEPLOY_METHOD || 'tar',
			platform: process.env.DEPLOY_PLATFORM || 'selfinstall',
		};

		statistics.enterpriseReady = true;

		statistics.uploadsTotal = Uploads.find().count();
		const [result] = Promise.await(Uploads.model.rawCollection().aggregate([{
			$group: { _id: 'total', total: { $sum: '$size' } },
		}], { readPreference }).toArray());
		statistics.uploadsTotalSize = result ? result.total : 0;

		statistics.migration = Migrations._getControl();
		statistics.instanceCount = InstanceStatus.getCollection().find({ _updatedAt: { $gt: new Date(Date.now() - process.uptime() * 1000 - 2000) } }).count();

		const { oplogEnabled, mongoVersion, mongoStorageEngine } = getMongoInfo();
		statistics.oplogEnabled = oplogEnabled;
		statistics.mongoVersion = mongoVersion;
		statistics.mongoStorageEngine = mongoStorageEngine;

		statistics.uniqueUsersOfYesterday = Sessions.getUniqueUsersOfYesterday();
		statistics.uniqueUsersOfLastWeek = Sessions.getUniqueUsersOfLastWeek();
		statistics.uniqueUsersOfLastMonth = Sessions.getUniqueUsersOfLastMonth();
		statistics.uniqueDevicesOfYesterday = Sessions.getUniqueDevicesOfYesterday();
		statistics.uniqueDevicesOfLastWeek = Sessions.getUniqueDevicesOfLastWeek();
		statistics.uniqueDevicesOfLastMonth = Sessions.getUniqueDevicesOfLastMonth();
		statistics.uniqueOSOfYesterday = Sessions.getUniqueOSOfYesterday();
		statistics.uniqueOSOfLastWeek = Sessions.getUniqueOSOfLastWeek();
		statistics.uniqueOSOfLastMonth = Sessions.getUniqueOSOfLastMonth();

		statistics.apps = getAppsStatistics();

		const integrations = Promise.await(Integrations.model.rawCollection().find({}, {
			projection: {
				_id: 0,
				type: 1,
				enabled: 1,
				scriptEnabled: 1,
			},
			readPreference,
		}).toArray());

		statistics.integrations = {
			totalIntegrations: integrations.length,
			totalIncoming: integrations.filter((integration) => integration.type === 'webhook-incoming').length,
			totalIncomingActive: integrations.filter((integration) => integration.enabled === true && integration.type === 'webhook-incoming').length,
			totalOutgoing: integrations.filter((integration) => integration.type === 'webhook-outgoing').length,
			totalOutgoingActive: integrations.filter((integration) => integration.enabled === true && integration.type === 'webhook-outgoing').length,
			totalWithScriptEnabled: integrations.filter((integration) => integration.scriptEnabled === true).length,
		};

		statistics.pushQueue = Promise.await(NotificationQueue.col.estimatedDocumentCount());

		statistics.enterprise = Promise.await(getEnterpriseStatistics());

		console.log(statistics);

		return statistics;
	},
	save() {
		const rcStatistics = statistics.get();
		rcStatistics.createdAt = new Date();
		Statistics.insert(rcStatistics);
		return rcStatistics;
	},
};
