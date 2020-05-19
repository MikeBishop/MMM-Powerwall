/* global Module */

/* Magic Mirror
 * Module: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

const DISPLAY_SOURCES = [
	{ key: "solar", displayAs: "Solar", color: "gold" },
	{ key: "battery", displayAs: "Powerwall Discharge", color: "green"},
	{ key: "grid", displayAs: "Grid Import", color: "gray" }
];
const DISPLAY_SINKS = [
	{ key: "house", displayAs: "Local Usage", color: "blue" },
	{ key: "car", displayAs: "Car Charging", color: "red" },
	{ key: "battery", displayAs: "Powerwall Charging", color: "green" },
	{ key: "grid", displayAs: "Grid Export", color: "gray" }
];

Module.register("MMM-Powerwall", {
	defaults: {
		graphs: ["SolarProduction"],
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
	teslaAggregates: null,
	flows: null,
	historySeries: null,
	chargingState: null,
	charts: {},

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

		setInterval(function() {
			self.sendSocketNotification("MMM-Powerwall-UpdateLocal");
		}, self.config.localUpdateInterval);
		setInterval(function() {
			self.sendSocketNotification("MMM-Powerwall-UpdateCloud");
		}, self.config.cloudUpdateInterval);
	},

	getTemplate: function() {
		return "MMM-Powerwall.njk";
	},

	getTemplateData: function() {
		let result = {
			id: this.identifier,
			config: this.config,
			twcEnabled: this.twcEnabled,
			teslaAPIEnabled: this.teslaAPIEnabled,
			flows: this.flows,
			historySeries: this.historySeries,
			chargingState: this.chargingState,
		};

		Log.log("Returning " + JSON.stringify(result));
		return result;
	},

	getScripts: function() {
		return [this.file("node_modules/chart.js/dist/Chart.bundle.js")];
	},

	getStyles: function () {
		return [
			"MMM-Powerwall.css",
		];
	},

	// socketNotificationReceived from helper
	socketNotificationReceived: function (notification, payload) {
		Log.log("Received " + notification + ": " + JSON.stringify(payload));
		if(notification === "MMM-Powerwall-Aggregates") {
			if( payload.ip === this.config.powerwallIP ) {
				let needUpdate = false;
				if (!this.flows) {
					needUpdate = true;
				}

				this.teslaAggregates = payload.aggregates;
				this.flows = this.attributeFlows(payload.aggregates, self.twcConsumption);
				if (needUpdate) {
					// If we didn't have data before, we need to redraw
					this.updateDom();
				}
				else {
					// We're updating the data in-place.

					/*******************
					 * SolarProduction *
					 *******************/
					let productionNode = document.getElementById(this.identifier + "-SolarProduction");
					let solarProduction = this.flows.sources.solar.total;
					if (solarProduction > 950) {
						productionNode.innerText = Math.trunc(solarProduction / 100) / 10.0 + " kW";
					}
					else {
						productionNode.innerText = Math.trunc(solarProduction) + " W"
					}
				}
			}
		}
	},

	notificationReceived: function(notification, payload, sender) {
		var self = this;
		if( !sender ) {
			// Received from core system
			if( notification === "MODULE_DOM_CREATED" ) {
				// DOM has been created -- container will be consistent, but children may be recreated
				var myDiv = document.getElementById(this.identifier);
				for( const node of myDiv.children ) {
					if( node.classList.contains("module-content") ) {
						// Here's the content div, which we need to observe
						const config = {attributes: false, childList: true, subtree: false };
						this.observer = new MutationObserver(function(mutationsList, observer) {self.buildGraphs(); });
						this.observer.observe(node, config);
						
						// Need to trigger it the first time
						self.buildGraphs()
						break;
					}
					else {
						Log.log("Found a non-match")
					}
				}
			}
		}
	},

	buildGraphs: function() {
		Log.log("Rebuilding graphs")
		var myCanvas = document.getElementById(this.identifier + "-SolarDestinations");
		if( myCanvas ) {
			let distribution = this.flows.sources.solar.distribution;
			let toDisplay = DISPLAY_SINKS.filter((entry) => distribution[entry.key] > 0);

			// Build the chart on the canvas
			var solarProductionPie = new Chart(myCanvas, {
				type: "doughnut",
				data: {
					datasets: [{
							data: toDisplay.map( (entry) => distribution[entry.key] ),
							backgroundColor: toDisplay.map( (entry) => entry.color )
						}],
					labels: toDisplay.map( (entry) => entry.displayAs ),
				}
			});
			this.charts.solarProduction = solarProductionPie;
			// self.kerfluffle.foo = 1
		}
	},
	
	attributeFlows: function(teslaAggregates, twcConsumption) {
		if( teslaAggregates ) {
			let solar = Math.trunc(teslaAggregates.solar.instant_power);
			let battery = Math.trunc(teslaAggregates.battery.instant_power);
			let house = Math.trunc(teslaAggregates.load.instant_power);
			let car = 0;
			if( twcConsumption ) {
				car = twcConsumption;
				house -= car;
			}
			let grid = teslaAggregates.site.instant_power;

			let flows = {
				solar: {
					unassigned: solar,
					battery: 0,
					house: 0,
					car: 0,
					grid: 0
				},
				battery: {
					unassigned: ((battery > 0) ? battery : 0),
					house: 0,
					car: 0,
					grid: 0
				},
				grid: {
					unassigned: ((grid > 0) ? grid : 0),
					battery: 0,
					house: 0,
					car: 0
				},
				unassigned: {
					battery: ((battery < 0) ? Math.abs(battery) : 0),
					house: house,
					car: car,
					grid: ((grid < 0) ? Math.abs(grid) : 0)
				}
			}

			for( const source of ["solar", "battery", "grid"]) {
				for( const sink of ["battery", "house", "car", "grid"]) {
					let amount_to_claim = Math.min(flows[source].unassigned, flows.unassigned[sink]);
					flows[source].unassigned -= amount_to_claim;
					flows.unassigned[sink] -= amount_to_claim;
					flows[source][sink] = amount_to_claim;
				}
				delete flows[source].unassigned;
			}

			return {
				sources: {
					solar: {
						total: solar,
						distribution: flows.solar,
					},
					battery: {
						total: ((battery > 0) ? battery : 0),
						distribution: flows.battery,
					},
					grid: {
						total: ((grid > 0) ? grid : 0),
						distribution: flows.grid,
					}
				},
				sinks: {
					battery: {
						total: ((battery < 0) ? Math.abs(battery) : 0),
						sources: {
							solar: flows.solar.battery,
							grid: flows.grid.battery
						}
					},
					house: {
						total: house,
						sources: {
							solar: flows.solar.house,
							battery: flows.battery.house,
							grid: flows.grid.house
						}
					},
					car: {
						total: car,
						sources: {
							solar: flows.solar.car,
							battery: flows.battery.car,
							grid: flows.grid.car
						}
					},
					grid: {
						total: ((grid < 0) ? Math.abs(grid) : 0),
						sources: {
							solar: flows.solar.grid,
							battery: flows.battery.grid
						}
					}
				}
			};
		}
		else {
			return null;
		}
	}
});
