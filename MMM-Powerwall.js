/* global Module */

/* Magic Mirror
 * Module: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

const SOLAR = { key: "solar", displayAs: "Solar", color: "gold" };
const POWERWALL = { key: "battery", displayAs: "Powerwall", color: "#0BC60B"};
const GRID = { key: "grid", displayAs: "Grid", color: "#CACECF" };
const HOUSE = { key: "house", displayAs: "Local Usage", color: "#09A9E6" };
const CAR = { key: "car", displayAs: "Car Charging", color: "#EA4659" };

const DISPLAY_SOURCES = [
	SOLAR,
	POWERWALL,
	GRID
];
const DISPLAY_SINKS = [
	POWERWALL,
	CAR,
	HOUSE,
	GRID
];

Module.register("MMM-Powerwall", {
	defaults: {
		graphs: ["SolarProduction", "HouseConsumption"],
		localUpdateInterval: 10000,
		cloudUpdateInterval: 60000,
		powerwallIP: null,
		powerwallPassword: null,
		siteID: null,
		twcManagerIP: null,
		twcManagerPort: 8080,
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
	totals: {
		grid: null,
		solar: null,
		battery: null,
		house: null,
	},
	dayMode: "day",
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
				twcManagerIP: self.config.twcManagerIP,
				port: self.config.twcManagerPort
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
		var updateLocal = function() {
			self.sendSocketNotification("MMM-Powerwall-UpdateLocal", {
				powerwallIP: self.config.powerwallIP,
				twcManagerIP: self.config.twcManagerIP
			});
		};
		var updateCloud = function() {
			self.sendSocketNotification("MMM-Powerwall-UpdateCloud");
		};

		setInterval(updateLocal, self.config.localUpdateInterval);
		setInterval(updateCloud, self.config.cloudUpdateInterval);
		updateLocal();
		updateCloud();
	},

	getTemplate: function() {
		return "MMM-Powerwall.njk";
	},

	getTemplateData: function() {
		let result = {
			id: this.identifier,
			dayMode: this.dayMode,
			config: this.config,
			twcEnabled: this.twcEnabled,
			teslaAPIEnabled: this.teslaAPIEnabled,
			flows: this.flows,
			totals: this.totals,
			historySeries: this.historySeries,
			chargingState: this.chargingState,
		};

		Log.log("Returning " + JSON.stringify(result));
		return result;
	},

	getScripts: function() {
		return [
			this.file("node_modules/chart.js/dist/Chart.bundle.js"),
			this.file("node_modules/chartjs-plugin-datalabels/dist/chartjs-plugin-datalabels.min.js"),
		];
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
					this.updateData();
				}
			}
		}
		else if (notification === "MMM-Powerwall-ChargeStatus") {
			if( payload.ip === this.config.twcManagerIP ) {
				let oldConsumption = self.twcConsumption;
				self.twcConsumption = Math.round( parseFloat(payload.status.chargerLoadWatts) );
				if( self.twcConsumption !== oldConsumption && this.teslaAggregates ) {
					this.flows = this.attributeFlows(this.teslaAggregates, self.twcConsumption);
					this.updateData();
				}
			}
		}
	},
	
	formatAsK: function(number, unit) {
		if( number > 950 ) {
			return Math.round(number / 100) / 10.0 + " k" + unit;
		}
		else {
			return Math.round(number) + " " + unit;
		}
	},

	updateNode: function(id, value, unit) {
		let targetNode = document.getElementById(id);
		if (targetNode) {
			targetNode.innerText = this.formatAsK(value, unit);
		}
	},

	updateChart: function(chart, display_array, distribution) {
		if( chart ) {
			chart.data.datasets[0].data = display_array.map( (entry) => distribution[entry.key] );
			chart.update();
		}
	},

	updateData: function() {
		/*******************
		 * SolarProduction *
		 *******************/
		this.updateNode(this.identifier + "-SolarProduction", this.flows.sources.solar.total, "W");
		this.updateChart(this.charts.solarProduction, DISPLAY_SINKS, this.flows.sources.solar.distribution);

		/********************
		 * HouseConsumption *
		 ********************/
		this.updateNode(this.identifier + "-HouseConsumption", this.flows.sinks.house.total, "W");
		this.updateChart(this.charts.houseConsumption, DISPLAY_SOURCES, this.flows.sinks.house.sources);
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
		else if ( notification === "CURRENTWEATHER_DATA" ) {
			let data = payload.data;
			let sunrise = new Date(data.sys.sunrise * 1000);
			let sunset = new Date(data.sys.sunset * 1000);
			let now = new Date();

			let newMode = "";
			if (now < sunrise) {
				newMode = "morning";
			}
			else if (sunset < now) {
				newMode = "night";
			}
			else {
				newMode = "day";
			}
			if( newMode != this.dayMode ) {
				this.dayMode = newMode;
				this.updateDom();
			}
		}
	},

	buildGraphs: function() {
		Log.log("Rebuilding graphs");
		var self = this;

		Chart.helpers.merge(Chart.defaults.global, {
			responsive: true,
			maintainAspectRatio: true,
			legend: false,
			aspectRatio: 1.2,
			elements: {
				arc: {
					borderWidth: 0
				}
			},
			tooltips: {
				enabled: false
			},
			plugins: {
				datalabels: {
					color: "white",
					anchor: "center",
					textalign: "center",
					display: function(context) {
						return context.dataset.data[context.dataIndex] > 0 ? "auto" : false;
					},
					labels: {
						title: {
							font: {
								size: 16,
								weight: "bold"
							}
						}
					},
					formatter: function(value, context) {
						return [
							context.dataset.labels[context.dataIndex],
							self.formatAsK(value, "W")
						];
					}
				}
			}
		});

		var myCanvas = document.getElementById(this.identifier + "-SolarDestinations");
		if( myCanvas ) {
			let distribution = this.flows.sources.solar.distribution;

			// Build the chart on the canvas
			var solarProductionPie = new Chart(myCanvas, {
				type: "pie",
				data: {
					datasets: [
					{
						data: DISPLAY_SINKS.map( (entry) => distribution[entry.key] ),
						backgroundColor: DISPLAY_SINKS.map( (entry) => entry.color ),
						weight: 2,
						labels: DISPLAY_SINKS.map( (entry) => entry.displayAs )
					},
					{
						data: [1],
						backgroundColor: SOLAR.color,
						weight: 1,
						showLine: false,
						datalabels: {
							labels: {
								title: null,
								value: null
							}
						}
					}]
				}
			});
			this.charts.solarProduction = solarProductionPie;
			// self.kerfluffle.foo = 1
		}

		myCanvas = document.getElementById(this.identifier + "-HouseSources");
		if( myCanvas ) {
			let distribution = this.flows.sinks.house.sources;

			// Build the chart on the canvas
			var houseConsumptionPie = new Chart(myCanvas, {
				type: "pie",
				data: {
					datasets: [
					{
						data: DISPLAY_SOURCES.map( (entry) => distribution[entry.key] ),
						backgroundColor: DISPLAY_SOURCES.map( (entry) => entry.color ),
						weight: 2,
						labels: DISPLAY_SOURCES.map( (entry) => entry.displayAs )
					},
					{
						data: [1],
						backgroundColor: HOUSE.color,
						weight: 1,
						showLine: false,
						datalabels: {
							labels: {
								title: null,
								value: null
							}
						}
					}]
				}
			});
			this.charts.houseConsumption = houseConsumptionPie;
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
					grid: 0,
					battery: 0
				},
				grid: {
					unassigned: ((grid > 0) ? grid : 0),
					battery: 0,
					house: 0,
					car: 0,
					grid: 0
				},
				unassigned: {
					battery: ((battery < 0) ? Math.abs(battery) : 0),
					house: house,
					car: car,
					grid: ((grid < 0) ? Math.abs(grid) : 0)
				}
			}

			for( const source of DISPLAY_SOURCES.map((value) => value.key) ) {
				for( const sink of DISPLAY_SINKS.map((value) => value.key) ) {
					let amount_to_claim = Math.min(flows[source].unassigned, flows.unassigned[sink]);
					flows[source].unassigned -= amount_to_claim;
					flows.unassigned[sink] -= amount_to_claim;
					flows[source][sink] = amount_to_claim;
				}
				delete flows[source].unassigned;
			}

			let result = {
				sources: {},
				sinks: {}
			}

			for (const source of DISPLAY_SOURCES) {
				let target = {};
				let total = 0;
				target.distribution = flows[source.key]
				for( const sink of DISPLAY_SINKS) {
					total += flows[source.key][sink.key];
				}
				target.total = total;
				result.sources[source.key] = target;
			}
			for (const sink of DISPLAY_SINKS) {
				let target = {};
				let total = 0;
				target.sources = {};
				for( const source of DISPLAY_SOURCES) {
					total += flows[source.key][sink.key];
					target.sources[source.key] = flows[source.key][sink.key];
				}
				target.total = total;
				result.sinks[sink.key] = target;
			}
			return result;
		}
		else {
			return null;
		}
	}
});
