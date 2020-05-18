/* global Module */

/* Magic Mirror
 * Module: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

Module.register("MMM-Powerwall", {
	defaults: {
		localUpdateInterval: 10000,
		cloudUpdateInterval: 60000,
		powerwallIP: null,
		powerwallPassword: null,
		siteID: null,
		twcManagerIP: null,
		teslaAPIUsername: null,
		teslaAPIPassword: null
	},
	requiresVersion: "2.1.0", // Required version of MagicMirror
	twcEnabled: null,
	teslaAPIEnabled: null,
	aggregates: null,
	historySeries: null,
	chargingState: null,

	start: function() {
		var self = this;

		//Flag for check if module is loaded
		this.loaded = false;

		//Send settings to helper
		self.sendSocketNotification("MMM-Powerwall-Configure-Powerwall",
		  {
			updateInterval: self.config.localUpdateInterval,
			powerwallIP: self.config.powerwallIP,
			powerwallPassword: self.config.powerwallPassword
		  });

		if (self.config.twcManagerIP) {
			self.sendSocketNotification("MMM-Powerwall-Configure-TWCManager",
			{
				updateInterval: self.config.localUpdateInterval,
				twcManagerIP: self.config.twcManagerIP
			});
			self.twcEnabled = true;
		}
		else {
			self.twcEnabled = false;
		}

		if (self.config.teslaAPIUsername && self.config.teslaAPIPassword ) {
			self.sendSocketNotification("MMM-Powerwall-Configure-TeslaAPI",
			{
				updateInterval: self.config.cloudUpdateInterval,
				siteID: self.config.siteID,
				teslaAPIUsername: self.config.teslaAPIUsername,
				teslaAPIPassword: self.config.teslaAPIPassword
			});
			self.teslaAPIEnabled = true;
		}
		else {
			self.teslaAPIEnabled = false;
		}
	},

	getTemplate: function() {
		return "MMM-Powerwall.njk"
	},

	getTemplateData: function() {
		return {
			config: this.config,
			twcEnabled: this.twcEnabled,
			teslaAPIEnabled: self.teslaAPIEnabled,
			aggregates: self.aggregates,
			historySeries: self.historySeries,
			chargingState: self.chargingState,
		}
	},

	getScripts: function() {
		//TODO:  Will need the ChartJS script here
		return [];
	},

	getStyles: function () {
		return [
			"MMM-Powerwall.css",
		];
	},

	// socketNotificationReceived from helper
	socketNotificationReceived: function (notification, payload) {
		if(notification === "MMM-Powerwall-POWERWALL_COUNTERS") {
			// set dataNotification
			this.dataNotification = payload;
			//this.updateDom();
			// May not need to updateDom; use chartJs to directly modify the graphs
		}
	},
});
