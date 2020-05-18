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

	start: function() {
		var self = this;
		var aggregates = null;
		var historySeries = null;
		var chargingState = null;

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
		}

		if (self.config.teslaAPIUsername && self.config.teslaAPIPassword ) {
			self.sendSocketNotification("MMM-Powerwall-Configure-TeslaAPI",
			{
				updateInterval: self.config.cloudUpdateInterval,
				siteID: self.config.siteID,
				teslaAPIUsername: self.config.teslaAPIUsername,
				teslaAPIPassword: self.config.teslaAPIPassword
			});
		  }
	},

	getDom: function() {
		var self = this;

		// create element wrapper for show into the module
		var wrapper = document.createElement("div");
		// If this.dataRequest is not empty
		if (this.dataRequest) {
			var wrapperDataRequest = document.createElement("div");
			// check format https://jsonplaceholder.typicode.com/posts/1
			wrapperDataRequest.innerHTML = this.dataRequest.title;

			var labelDataRequest = document.createElement("label");
			// Use translate function
			//             this id defined in translations files
			labelDataRequest.innerHTML = this.translate("TITLE");

			wrapper.appendChild(labelDataRequest);
			wrapper.appendChild(wrapperDataRequest);
		}

		// Data from helper
		if (this.dataNotification) {
			var wrapperDataNotification = document.createElement("div");
			// translations  + datanotification
			wrapperDataNotification.innerHTML =  this.translate("UPDATE") + ": " + this.dataNotification.date;

			wrapper.appendChild(wrapperDataNotification);
		}
		return wrapper;
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

	processData: function(data) {
		var self = this;
		this.dataRequest = data;
		if (this.loaded === false) { self.updateDom(self.config.animationSpeed) ; }
		this.loaded = true;

		// the data if load
		// send notification to helper
		this.sendSocketNotification("MMM-Powerwall-NOTIFICATION_TEST", data);
	},

	// socketNotificationReceived from helper
	socketNotificationReceived: function (notification, payload) {
		if(notification === "MMM-Powerwall-POWERWALL_COUNTERS") {
			// set dataNotification
			this.dataNotification = payload;
			this.updateDom();
		}
	},
});
