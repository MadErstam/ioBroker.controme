"use strict";

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter

// const { Adapter } = require("@iobroker/adapter-core");

const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
const got = require('got').default;
const { HTTPError } = require('got');  // Import HTTPError for specific error checking
const dayjs = require('dayjs');
const formData = require('form-data');
const { isObject } = require("iobroker.controme/lib/tools");

function roundTo(number, decimals = 0) {
    return Math.round(number * Math.pow(10, decimals)) / Math.pow(10, decimals);	
}

class Controme extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "controme",
		});
		this.delayPolling = false; // is set when a connection error is detected and prevents polling
		this.delayPollingCounter = 0; // controls the duration, for which polling is delayed
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		// this.on('message', obj => {
		// 	this.log.debug(`Message received: ${JSON.stringify(obj)}`)
		// });		
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		const pollInterval = (Number.isInteger(this.config.interval) && this.config.interval > 15) ? this.config.interval : 15;

		this.log.debug(`Controme URL: ${this.config.url}; houseID: ${this.config.houseID}; user: ${this.config.user}; update interval: ${pollInterval}; warnOnNull: ${this.config.warnOnNull}`);


		if (this.config.forceReInit) {
			this.log.debug(`Fresh install of adapter or forceReInit selected, initializing object structure.`);
			try {
				const objects = await this.getAdapterObjectsAsync();

				for (const object in objects) {
					if (Object.prototype.hasOwnProperty.call(objects, object)) {
						this.log.silly(`Purging: ${object}`);
						if (!object.endsWith("info.connection")) {
							await this.delForeignObjectAsync(object);
						}
					}
				}
				this.log.debug(`Purging object structure finished successfully`);
			} catch (error) {
				this.log.error(`Purging object structure failed with ${error}`);
			}

			try {
				await this._createObjects();
				this.setStateAsync("info.connection", true, true);
				this.log.debug(`Creating object structure finished successfully`);
			} catch (error) {
				this.log.error(`Creating object structure failed with ${error}`);
			}

			// Set foreceReInit to false after re-initialization to avoid recreating the object structure on each adapter restart
			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { forceReInit: false } });
				this.log.debug(`Initializing object structure finished successfully`);
			} catch (error) {
				this.log.error(`Could not set forceReinit to false: ${error}`);
			}

		}

		// Poll temperature data from the server immediately, followed by period polling
		this._updateIntervalFunction();

		// Poll temperature data from the server in the defined update interval
		this.updateInterval = setInterval(this._updateIntervalFunction.bind(this), pollInterval * 1000);

		// Subscribe to all states that can be written to
		this.subscribeStates("*.setpointTemperature");
		this.subscribeStates("*.sensors.*.actualTemperature");
		this.subscribeStates("*.offsets.*");

		this.setState("info.connection", true, true);

	}

	async onMessage(obj) {
		if (isObject(obj)) {
			this.log.debug(`onMessage called with obj: ${JSON.stringify(obj)}`);
		}
		// if (obj) {
		// 	switch (obj.command) {
		// 		case 'command':
		// 			if (obj.callback) {
		// 				this.log.debug(`onMessage called with obj: ${JSON.stringify(obj)}`);
		// 			}
		// 			break;
		// 	}
		// }
	}

	_updateIntervalFunction() {
		// Poll API, unless server is in error mode
		if (!this.delayPolling) {
			this._pollRoomTemps();
			this._pollOuts();
			if (this.config.gateways != null && typeof this.config.gateways[Symbol.iterator] === 'function') {
				this._pollGateways();
			}
		}
	}

	_delayPollingFunction () {
		this.delayPolling = true;
		this.delayPollingTimeout = setTimeout(() => {
			this.delayPolling = false;
		}, this.delayPollingCounter * 60 * 1000);
		this.delayPollingCounter < 10 ? this.delayPollingCounter++ : this.delayPollingCounter = 10;		
		this.setState("info.connection", false, true);
		this.log.error(`Error in polling data from Controme mini server; will retry in ${this.delayPollingCounter} minutes.`);
	}

	_resetPollingDelay () {
		this.delayPolling = false;
		this.delayPollingCounter = 0;
		this.setState("info.connection", true, true);
	}

	_processTempsAPIforCreation (body) {
		// response JSON contains hierarchical information starting with floors and rooms on these floors
		// followed by offsets and sensors for each room
		// we need to iterate through the floors and rooms and create the required structures
		// rooms will be our devices

		this.log.silly(`Temps response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);

		this.log.debug(`~  Creating room objects (incl. offsets and sensors)`);
		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
				const rooms = body[floor].raeume;
				for (const room in rooms) {
					if (Object.prototype.hasOwnProperty.call(rooms, room)) {
						this._createObjectsForRoom(rooms[room]);
						this._createOffsetsForRoom(rooms[room]);

						if (Object.prototype.hasOwnProperty.call(rooms[room], 'sensoren')) {
							for (const sensor in body[floor].raeume[room].sensoren) {
								if (Object.prototype.hasOwnProperty.call(body[floor].raeume[room].sensoren, sensor)) {
									this._createSensorsForRoom(body[floor].raeume[room].id, body[floor].raeume[room].sensoren[sensor]);
								}
							}
						}
					}
				}
			}
		}
	}

	_processOutsAPIforCreation (body) {
		// response JSON contains hierarchical information starting with floors and rooms on these floors
		// followed by outputs for each room
		// we need to iterate through the floors and rooms and add the required output structures to the already created rooms

		this.log.silly(`Outs response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
				const rooms = body[floor].raeume;
				for (const room in rooms) {
					if (Object.prototype.hasOwnProperty.call(rooms, room)) {
						this._createOutputsForRoom(rooms[room]);
					}
				}
			}
		}

		this.log.debug(`~  Creating gateway objects`);
		if (this.config.gateways != null && typeof this.config.gateways[Symbol.iterator] === 'function') {
			const gateways = Array.isArray(this.config.gateways) ? this.config.gateways : [this.config.gateways];
			for (const gateway of gateways) {
					// gateways is an array of objects, one for each output of the gateway
					const promises = this._createGatewayObjects(gateway);
				Promise.all(promises)
					.then(() => {
						this._setGatewayObjects(gateway);
					})
					.catch((error) => {
						this.log.error(`Setting newly created gateway states failed with error ${error}`);
					})
			}

			if (this.config.gatewayOuts != null && typeof this.config.gatewayOuts[Symbol.iterator] === 'function') {
				const gatewayOuts = Array.isArray(this.config.gatewayOuts) ? this.config.gatewayOuts : [this.config.gatewayOuts];
				this.log.debug(`~  Creating output objects for gateways`);

				for (const gatewayOutput of gatewayOuts) {
					// gatewayOuts is an array of objects, one for each output of the gateway
					this._createGatewayOutputObjects(gatewayOutput);
				}
			}

		}		
	}
	
	async _createObjects() {
		this.log.debug(`Creating object structure`);

		// Read temp API and create all required objects (rooms and sensors)
		let body;
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/temps/";
			const response = await got.get(url);
			body = JSON.parse(response.body);
			this._processTempsAPIforCreation(body);
		} catch (error) {
			this._delayPollingFunction();
			this.log.error(`Polling temps API from mini server to create data objects for rooms, offsets and sensor failed failed with error "${error}"`);
		}


		this.log.debug(`~  Creating output objects for rooms`);
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/outs/";
			const response = await got.get(url);
			body = JSON.parse(response.body);
			this._processOutsAPIforCreation(body);
		} catch (error) {
			this._delayPollingFunction();
			this.log.error(`Polling outs API from mini server to create data objects for outputs failed failed with error "${error}"`);
		}

		// the connection indicator is updated when the connection was successful
	}

	_createObjectsForRoom(room) {
		const promises = [];
		this.log.silly(`Creating objects for room ${room.id} (${room.name}): Basic object structure`);
		promises.push(this.setObjectNotExistsAsync(room.id.toString(), { type: "device", common: { name: room.name }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".actualTemperature", { type: "state", common: { name: room.name + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setpointTemperature", { type: "state", common: { name: room.name + " setpoint temperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temperatureOffset", { type: "state", common: { name: room.name + " temperature offset", type: "number", unit: "°C", role: "value", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setpointTemperaturePerm", { type: "state", common: { name: room.name + " permanent setpoint temperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".is_temporary_mode", { type: "state", common: { name: room.name + " is in temporary mode", type: "boolean", unit: "", role: "indicator", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temporary_mode_remaining", { type: "state", common: { name: room.name + "  temporary mode remaining time ", type: "number", unit: "s", role: "value.interval", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temporary_mode_end", { type: "state", common: { name: room.name + "  temporary mode end time ", type: "number", unit: "", role: "value.datetime", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".humidity", { type: "state", common: { name: room.name + " humidity", type: "number", unit: "%", role: "value.humidity", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".mode", { type: "state", common: { name: room.name + " operating mode", type: "string", unit: "", role: "level.mode", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".sensors", { type: "channel", common: { name: room.name + " sensors" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".offsets", { type: "channel", common: { name: room.name + " offsets" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".outputs", { type: "channel", common: { name: room.name + " outputs" }, native: {} }));
		return Promise.all(promises);
	}

	_createGatewayObjects(gw) {
		const promises = [];
		this.log.silly(`Creating gateway objects for ${gw.gatewayMAC}`);
		promises.push(this.setObjectNotExistsAsync(gw.gatewayMAC, { type: "device", common: { name: gw.gatewayName }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(gw.gatewayMAC + ".gatewayType", { type: "state", common: { name: gw.gatewayName + " type", type: "string", unit: "", role: "state", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(gw.gatewayMAC + ".isUniversal", { type: "state", common: { name: gw.gatewayName + " isUniversal", type: "boolean", unit: "", role: "state", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(gw.gatewayMAC + ".outputs", { type: "channel", common: { name: gw.gatewayName + " outputs" }, native: {} }));
		return promises;
	}

	_setGatewayObjects(gw) {
		const promises = [];
		this.log.silly(`Setting gateway objects for ${gw.gatewayMAC}`);
		promises.push(this.setStateAsync(gw.gatewayMAC + ".gatewayType", gw.gatewayType, true));
		promises.push(this.setStateAsync(gw.gatewayMAC + ".isUniversal", (gw.gatewayType == "gwUniMini" || gw.gatewayType == "gwUniPro"), true));
		return Promise.all(promises);
	}

	_createGatewayOutputObjects(gwo) {
		const promises = [];
		this.log.silly(`Creating gateway output object for ${gwo.gatewayOutsMAC} Output ${gwo.gatewayOutsID}`);
		promises.push(this.setObjectNotExistsAsync(gwo.gatewayOutsMAC + ".outputs." + gwo.gatewayOutsID, { type: "state", common: { name: gwo.gatewayOutsName, type: "number", unit: "", min: 0, max: 1, role: "state", read: true, write: false }, native: {} }));
		return Promise.all(promises);
	}

	isEmpty(object) {
		for (var i in object) {
			return false;
		}
		return true;
	}

	_createOffsetsForRoom(room) {
		const promises = [];
		for (const offset in room.offsets) {
			if (Object.prototype.hasOwnProperty.call(room.offsets, offset)) {
				if (typeof (room.offsets[offset]) === "object") {
					if (!this.isEmpty(room.offsets[offset])) {
						// if offset object is not empty, we create the relevant object structure
						promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + offset, { type: "channel", common: { name: room.name + " offset " + offset }, native: {} }));
						for (const offset_item in room.offsets[offset]) {
							if (Object.prototype.hasOwnProperty.call(room.offsets[offset], offset_item)) {
								this.log.silly(`Creating offset objects for room ${room.id}: Offset ${offset}.${offset_item}`);
								// all states for offset channel api should be read-write, else read-only
								promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + offset + "." + offset_item, { type: "state", common: { name: room.name + " offset " + offset + " " + offset_item, type: "number", unit: "°C", role: "value", read: true, write: (offset == "api") }, native: {} }));
							}
						}
					} else if (offset == "api") {
						// for an empty offset object "api", we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
						// this.log.silly(`Creating object structure for offset object ${offset}`);
						this.log.silly(`Creating offset objects for room ${room.id}: Offset ${offset}.api`);
						promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api", { type: "channel", common: { name: room.name + " offset api" }, native: {} }));
						promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api.raum", { type: "state", common: { name: room.name + " offset api raum", type: "number", unit: "°C", role: "value", read: true, write: true }, native: {} }));
					}
				}
			}
		}
		// Some servers do not include an api module, so the read/write states are not created. Check if "api" exists, if not, create it
		if (typeof (room.offsets["api"]) === "undefined") {
			// for the offset object api, we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
			// this.log.silly(`Creating object structure for offset object ${offset}`);
			this.log.info(`Creating objects for room ${room.id}: Offset api.api`);
			promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api", { type: "channel", common: { name: room.name + " offset api" }, native: {} }));
			promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api.raum", { type: "state", common: { name: room.name + " offset api raum", type: "number", unit: "°C", role: "value", read: true, write: true }, native: {} }));
		}
		return Promise.all(promises);
	}

	_createSensorsForRoom(roomID, sensor) {
		const promises = [];
		this.log.silly(`Creating sensor objects for room ${roomID}: Sensor ${sensor.name} (${sensor.beschreibung})`);
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name, { type: "device", common: { name: sensor.beschreibung }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name + ".isRoomTemperatureSensor", { type: "state", common: { name: sensor.beschreibung + " is room temperature sensor", type: "boolean", role: "indicator", read: true, write: false }, native: {} }));
		// sensor.wert can be either single value or object
		if (isObject(sensor.wert)) {
			for (const [key, value] of Object.entries(sensor.wert)) {
				this.log.silly(`Creating individual sensor value objects for room ${roomID}: Sensor value ${key}`);
				// currently known object values are Helligkeit (brightness), Relative Luftfeuchtigkeit (humidity), Bewegung (motion), Temperatur (temperatur)
				switch (key) {
					case "Helligkeit":
						promises.push(this.setObjectNotExistsAsync(`${roomID}.sensors.${sensor.name}.brightness`, { type: "state", common: { name: `${sensor.beschreibung} brightness`, type: "number", unit: "lux", role: "value.brightness", read: true, write: false }, native: {} }));
						break;
					case "Relative Luftfeuchte":
						promises.push(this.setObjectNotExistsAsync(`${roomID}.sensors.${sensor.name}.humidity`, { type: "state", common: { name: `${sensor.beschreibung} humidity`, type: "number", unit: "%", role: "value.humidity", read: true, write: false }, native: {} }));
						break;
					case "Bewegung":
						promises.push(this.setObjectNotExistsAsync(`${roomID}.sensors.${sensor.name}.motion`, { type: "state", common: { name: sensor.beschreibung + " motion", type: "boolean", role: "sensor.motion", read: true, write: false }, native: {} }));
						break;
					case "Temperatur":
						promises.push(this.setObjectNotExistsAsync(`${roomID}.sensors.${sensor.name}.actualTemperature`, { type: "state", common: { name: sensor.beschreibung + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: true }, native: {} }));
						break;
					default:
						promises.push(this.setObjectNotExistsAsync(`${roomID}.sensors.${sensor.name}.${key}`, { type: "state", common: { name: `${sensor.beschreibung} ${key}`, type: "number", unit: "", role: "value", read: true, write: true }, native: {} }));
				}
			}
		} else {
			promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name + ".actualTemperature", { type: "state", common: { name: sensor.beschreibung + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: true }, native: {} }));
		}
		return Promise.all(promises);
	}

	_createOutputsForRoom(room) {
		const promises = [];
		if (Object.prototype.hasOwnProperty.call(room, 'ausgang')) {
			const outputs = room.ausgang;
			for (const [key, value] of Object.entries(outputs)) {
				this.log.silly(`Creating output objects for room ${room.id}: Output ${key}`);
				promises.push(this.setObjectNotExistsAsync(room.id + ".outputs." + key, { type: "state", common: { name: room.name + " outputs " + key, type: "number", role: "value", read: true, write: false }, native: {} }));
			}
		}
		return Promise.all(promises);
	}

	_updateOffsetStatesForRoom(room) {
		// Controme deletes offsets that have been set via the api; we need to check which offsets still exist and delete those that do no longer exist
		// Get all offset states (states in channel offset) of the respective room and check if these are still included in the temps API response
		this.getStatesOf(`${this.namespace}.${room.id}`, "offsets", (err, obj) => {
			this.log.silly(`_updateOffsetStatesForRoom: getStatesOf returned obj: ${JSON.stringify(obj)}`);
			for (const offset in obj) {
				if (Object.prototype.hasOwnProperty.call(obj, offset)) {
					const roomID = obj[offset]._id.match(/^controme\.\d\.(\d+)/)[1];
					const offsetChannel = obj[offset]._id.match(/offsets\.([^.]+)\./)[1];
					const offsetState = obj[offset]._id.match(/offsets\.[^.]+\.([^.]+)/)[1];
					// offsetChannels are created by API, FPS, KI, and several other modules
					if (offsetChannel in room.offsets) {
						this.log.silly(`Offset channel ${roomID}.${offsetChannel} still exists in API response`);
						if (offsetState in room.offsets[offsetChannel]) {
							this.log.silly(`Offset state ${roomID}.${offsetChannel}.${offsetState} still exists in API response`);
						} else {
							// the previously existing offsetState does not exist anymore
							if (offsetChannel == "api") {
								// if the previously existing offsetState was created in the api channel, we leave it, but set it to 0°C
								this.log.silly(`Offset state ${offsetState} no longer exists in API response, but is in API channel, so setting it to 0°C`);
								this.setStateAsync(obj[offset]._id, 0, true);
							} else {
								// if the previously existing offsetState was created in any other channel than api, we delete it
								this.log.debug(`Deleting offset state ${obj[offset]._id}, since it does not exist in API response`);
								this.delObjectAsync(obj[offset]._id);
							}
						}
					} else {
						// if the previously existing offsetChannel does no longer exist in API response, we delete it
						if (offsetChannel != "api") {
							this.log.debug(`Deleting offset channel ${this.namespace}.${roomID}.${offsetChannel}, since it does not appear in API response`);
							this.delObjectAsync(`${this.namespace}.${roomID}.${offsetChannel}`);
						}
					}
				}
			}
		});
	}

	_processTempsAPIforUpdate(body) {
		this.log.silly(`Temps response from Controme mini server: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body, floor)) {
				for (const room in body[floor].raeume) {
					if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
						this.log.silly(`Processing temps API for room ${body[floor].raeume[room].id}`);
						this._updateRoom(body[floor].raeume[room]);

						// Controme deletes offsets that have been set via the api; we need to check which offsets still exist and delete those that do no longer exist
						this._updateOffsetStatesForRoom(body[floor].raeume[room]);

						// update offset and sensor values
						this._updateOffsetsForRoom(body[floor].raeume[room]);
						this._updateSensorsForRoom(body[floor].raeume[room]);
						this.log.silly(`Finished processing temps API for room ${body[floor].raeume[room].id}`);
					}
				}
			}
		}
	}

	async _pollRoomTemps() {
		// Poll data from temps API
		this.log.debug("Polling temps API from mini server");
		let body;

		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/temps/";
			const response = await got.get(url);
			body = JSON.parse(response.body);
			this._processTempsAPIforUpdate(body);
			this._resetPollingDelay();
		} catch (error) {
			this._delayPollingFunction();
			this.log.error(`Polling temperature data from Controme mini server finished with error "${error}"`);
		}

	}

	_processOutsAPIforUpdate (body) {
		this.log.silly(`Outs response from Controme mini server: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body, floor)) {
				for (const room in body[floor].raeume) {
					if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
						this.log.silly(`Processing outs API for room ${body[floor].raeume[room].id}`);

						this._updateOutputsForRoom(body[floor].raeume[room]);

						this.log.silly(`Finished processing outs API for room ${body[floor].raeume[room].id}`);
					}
				}
			}
		}
	}

	async _pollOuts() {
		// Poll data from outs API
		this.log.debug("Polling outs API  from mini server");
		let body;
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/outs/";
			const response = await got.get(url);
			body = JSON.parse(response.body);
			this._processOutsAPIforUpdate(body);
			this._resetPollingDelay();
		} catch (error) {
			// when an error is received, the connection indicator is updated accordingly
			this._delayPollingFunction();
			this.log.error(`Polling outputs data from Controme mini server finished with error "${error}"`);
		}

	}

	async _pollGateways() {
		// Poll gateway data from outputs API

		const gateways = Array.isArray(this.config.gateways) ? this.config.gateways : [this.config.gateways];
		for (const gateway of gateways) {
			// gateways is an array of objects, one for each gateway
			// for gateways other than universal gateways (where state isUniversal is true), we can query the outputs API with /all/			
			// for universal gateways we need to query each output individually
			let body;
			if (gateway.gatewayType == "gwUniPro") {
				this.log.debug(`Polling individual outputs for gateway ${gateway.gatewayName} from mini server `);
				const outputs = await this.getStatesOfAsync(`${this.namespace}.${gateway.gatewayMAC}`, "outputs");
				for (const output in outputs) {
					let outputID = outputs[output]._id.substring(outputs[output]._id.lastIndexOf('.') + 1);
					try {
						const url = `http://${this.config.url}/get/${gateway.gatewayMAC}/${outputID}/`;
						const response = await got.get(url);
						body = response.body;
						// gateway API returns string in the format <0;0;0;0;0;0;0;0;0;0;0;0;0;0;0>
						if (typeof (body) === "string") {

							const gatewayOutState = body.substring(1, body.length - 1);
							this.log.silly(`Setting gateway output ${gateway.gatewayMAC}:${outputID} to ${parseInt(gatewayOutState)}`);
							this.setStateAsync(outputs[output]._id, parseInt(gatewayOutState), true);
						}
						this._resetPollingDelay();	
					} catch (error) {
						// when an error is received, the connection indicator is updated accordingly
						this._delayPollingFunction();
						this.log.error(`Polling data for output ${gateway.gatewayMAC}:${outputID} finished with error "${error}"`);
					}

				}
			} else {
				this.log.debug(`Polling all outputs for gateway ${gateway.gatewayName} from mini server `);
				try {
					const url = `http://${this.config.url}/get/${gateway.gatewayMAC}/all/`;
					const response = await got.get(url);
					body = response.body;
					// gateway API returns string in the format <0;0;0;0;0;0;0;0;0;0;0;0;0;0;0>
					if (typeof (body) === "string") {
						const gatewayOuts = body.substring(1, body.length - 1).split(';');
						const outputs = await this.getStatesOfAsync(`${this.namespace}.${gateway.gatewayMAC}`, "outputs");
						for (const output in outputs) {
							let outputID = outputs[output]._id.substring(outputs[output]._id.lastIndexOf('.') + 1);
							this.setStateAsync(outputs[output]._id, parseFloat(gatewayOuts[parseInt(outputID) - 1]), true);
							this.log.silly(`Setting gateway output ${gateway.gatewayMAC}:${outputID} to ${parseFloat(gatewayOuts[parseInt(outputID) - 1])}`);
						}
					}
					this._resetPollingDelay();	
				} catch (error) {
					// when an error is received, the connection indicator is updated accordingly
					this._delayPollingFunction();
					this.log.error(`Polling gateway data on ${gateway.gatewayMAC} from Controme mini server finished with error "${error}"`);
				}
			}
		}

	}


	/*

		promises.push(this.setObjectNotExistsAsync(room.id.toString(), { type: "device", common: { name: room.name }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".actualTemperature", { type: "state", common: { name: room.name + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setpointTemperature", { type: "state", common: { name: room.name + " setpoint temperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temperatureOffset", { type: "state", common: { name: room.name + " temperature offset", type: "number", unit: "°C", role: "value", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setpointTemperaturePerm", { type: "state", common: { name: room.name + " permanent setpoint temperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".is_temporary_mode", { type: "state", common: { name: room.name + " is in temporary mode", type: "boolean", unit: "", role: "indicator", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temporary_mode_remaining", { type: "state", common: { name: room.name + "  temporary mode remaining time ", type: "number", unit: "s", role: "value.interval", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temporary_mode_end", { type: "state", common: { name: room.name + "  temporary mode end time ", type: "string", unit: "", role: "value.datetime", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".humidity", { type: "state", common: { name: room.name + " humidity", type: "number", unit: "%", role: "value.humidity", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".mode", { type: "state", common: { name: room.name + " operating mode", type: "string", unit: "", role: "level.mode", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".sensors", { type: "channel", common: { name: room.name + " sensors" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".offsets", { type: "channel", common: { name: room.name + " offsets" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".outputs", { type: "channel", common: { name: room.name + " outputs" }, native: {} }));

	*/

	_updateRoom(room) {
		const promises = [];
		this.log.silly(`Updating room ${room.id} (${room.name}): Actual temperature ${roundTo(parseFloat(room.temperatur), 2)} °C, setpoint temperature ${roundTo(parseFloat(room.solltemperatur), 2)} °C, temperature offset ${roundTo(parseFloat(room.total_offset), 2)} °C`);
		promises.push(this.setStateChangedAsync(room.id + ".actualTemperature", roundTo(parseFloat(room.temperatur), 2), true));
		promises.push(this.setStateChangedAsync(room.id + ".setpointTemperature", roundTo(parseFloat(room.solltemperatur), 2), true));
		promises.push(this.setStateChangedAsync(room.id + ".temperatureOffset", roundTo(parseFloat(room.total_offset), 2), true));
		promises.push(this.setStateChangedAsync(room.id + ".setpointTemperaturePerm", roundTo(parseFloat(room.perm_solltemperatur), 2), true));
		promises.push(this.setStateChangedAsync(room.id + ".is_temporary_mode", room.is_temporary_mode == 'true', true));
		promises.push(this.setStateChangedAsync(room.id + ".temporary_mode_remaining", parseInt(room.remaining_time), true));
		if (room.mode_end_datetime == null) {
			promises.push(this.setStateChangedAsync(room.id + ".temporary_mode_end", room.mode_end_datetime, true));
		} else {
			promises.push(this.setStateChangedAsync(room.id + ".temporary_mode_end", dayjs(room.mode_end_datetime).unix(), true));
		}
		promises.push(this.setStateChangedAsync(room.id + ".humidity", parseInt(room.luftfeuchte), true));
		promises.push(this.setStateChangedAsync(room.id + ".mode", room.betriebsart, true));
		return Promise.all(promises);
	}

	hasJsonStructure(str) {
		if (typeof str !== 'string') return false;
		try {
			const result = JSON.parse(str);
			const type = Object.prototype.toString.call(result);
			return type === '[object Object]'
				|| type === '[object Array]';
		} catch (err) {
			return false;
		}
	}

	_updateOffsetsForRoom(room) {
		const promises = [];
		for (const offset in room.offsets) {
			if (Object.prototype.hasOwnProperty.call(room.offsets, offset)) {
				if (typeof (room.offsets[offset]) === "object") {
					if (!this.isEmpty(room.offsets[offset])) {
						// if offset object is not empty, we update the relevant object structure
						for (const offset_item in room.offsets[offset]) {
							if (Object.prototype.hasOwnProperty.call(room.offsets[offset], offset_item)) {
								this.log.silly(`Updating room ${room.id}: Offset ${offset}.${offset_item} to ${roundTo(parseFloat(room.offsets[offset][offset_item]), 2)} °C`);
								promises.push(this.setStateChangedAsync(room.id + ".offsets." + offset + "." + offset_item, roundTo(parseFloat(room.offsets[offset][offset_item]), 2), true));
							}
						}
					}
				}
			}
		}
		return Promise.all(promises);
	}

	_updateSensorsForRoom(room) {
		const promises = [];
		for (const sensor in room.sensoren) {
			if (Object.prototype.hasOwnProperty.call(room.sensoren, sensor)) {
				try {
					this.log.silly(`${room.id}.sensors.${room.sensoren[sensor].name}.isRoomTemperatureSensor: ${room.sensoren[sensor].raumtemperatursensor}`);
					promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".isRoomTemperatureSensor", room.sensoren[sensor].raumtemperatursensor, true));

					// sensor.wert can be either an object or a float
					if (room.sensoren[sensor].wert && typeof (room.sensoren[sensor].wert) === "object") {
						//  {"raumtemperatursensor":true,"letzte_uebertragung":"18.03.2021 18:23","name":"05:90:22:a2","wert":{"Helligkeit":null,"Relative Luftfeuchte":null,"Bewegung":null,"Temperatur":21.80392156862745}

						// Check temperatur value for validity; could be null or empty, if sensor is not delivering values
						if (room.sensoren[sensor].wert.Temperatur) {
							if (isNaN(parseFloat(room.sensoren[sensor].wert.Temperatur))) {
								this.log.warn(`Room ${room.id}: Temperature value for sensor ${room.sensoren[sensor].name} is not a number`);
							} else {
								this.log.silly(`Updating room ${room.id}: Sensor ${room.sensoren[sensor].name} (${room.sensoren[sensor].beschreibung}) to ${room.sensoren[sensor].wert.Temperatur} °C`);
								promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", roundTo(parseFloat(room.sensoren[sensor].wert.Temperatur), 2), true));
							}
						} else if (this.config.warnOnNull) {
							this.log.warn(`Room ${room.id}: Temperature value for sensor ${room.sensoren[sensor].name} is null or empty`);
						}

					} else {
						// Check temperatur value for validity; could be null or empty, if sensor is not delivering values
						if (room.sensoren[sensor].wert) {
							if (isNaN(parseFloat(room.sensoren[sensor].wert))) {
								this.log.warn(`Room ${room.id}: Value for sensor ${room.sensoren[sensor].name} is not a number`);
							} else {
								this.log.silly(`Updating room ${room.id}: Sensor ${room.sensoren[sensor].name} (${room.sensoren[sensor].beschreibung}) to ${roundTo(parseFloat(room.sensoren[sensor].wert), 2)} °C`);
								promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", roundTo(parseFloat(room.sensoren[sensor].wert), 2), true));
							}
						} else if (this.config.warnOnNull) {
							this.log.warn(`Room ${room.id}: Temperature value for sensor ${room.sensoren[sensor].name} is null or empty`);
						}
					}
				} catch (error) {
					this.log.error(`Room ${room.id}: Updating sensor values returned an error "${error}"`);
				}
			}
		}
		return Promise.all(promises);
	}

	_updateOutputsForRoom(room) {
		const promises = [];
		if (Object.prototype.hasOwnProperty.call(room, 'ausgang')) {
			const outputs = room.ausgang;
			for (const [key, value] of Object.entries(outputs)) {
				this.log.silly(`Updating room ${room.id}: Output: ${key} to ${value}`);
				promises.push(this.setStateChangedAsync(room.id + ".outputs." + key, parseFloat(value), true));
			}
		}
		return Promise.all(promises);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug("Stopping update interval.");
			// Here you must clear all timeouts or intervals that may still be active
			if (this.updateInterval != null) { clearInterval(this.updateInterval); }
			if (typeof this.delayPollingTimeout === "number") { clearTimeout(this.delayPollingTimeout); }
			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// A subscribed state was changed. We need to only react on changes initiated by the used, where ack == false
			if (state.ack == false) {
				// identify which of the subscribed states has changed
				if (id.endsWith(".setpointTemperature")) {
					// this.subscribeStates("*.setpointTemperature");
					// extract the roomID from id
					const roomID = id.match(/^controme\.\d\.(\d+)/);
					if (roomID !== null && state.val !== null) {
						this.log.debug(`Room ${roomID[1]}: Calling setSetpointTemp(${roomID[1]}, ${state.val})`);
						this._setSetpointTemp(roomID[1], state.val);
					} else {
						this.log.error(`Change of subscribed state ${id} to ${state.val} °C (ack = ${state.ack}) failed`);
					}
				} else if (id.endsWith(".actualTemperature")) {
					// this.subscribeStates("*.sensor.*.actualTemperature");
					// extract the roomID and sensorID from id
					const roomID = id.match(/^controme\.\d\.(\d+)/);
					const sensorID = id.match(/\.sensors\.([0-9a-f_:]+)\./);
					if (roomID !== null && sensorID !== null && state.val !== null) {
						this.log.debug(`Room ${roomID[1]}: Calling setActualTemp(${roomID[1]}, ${sensorID[1]}, ${state.val})`);
						this._setActualTemp(roomID[1], sensorID[1], state.val);
					} else {
						this.log.error(`Change of subscribed actualTemperature state ${id} to ${state.val} °C (ack = ${state.ack}) failed`);
					}
				} else if (id.includes(".offsets.")) {
					// this.subscribeStates("*.offsets.api.*");
					// extract the apiID and sensorID from id
					const roomID = id.match(/^controme\.\d\.(\d+)/);
					const apiID = id.match(/offsets\.[^.]+\.(.+)/);
					if (roomID !== null && apiID !== null && state.val !== null) {
						this.log.debug(`Room ${roomID[1]}: Calling setOffsetTemp(${roomID[1]}, ${apiID[1]}, ${state.val})`);
						this._setOffsetTemp(roomID[1], apiID[1], state.val);
					} else {
						this.log.error(`Change of subscribed offset state ${id} to ${state.val} °C (ack = ${state.ack}) failed`);
					}
				} else {
					this.log.error(`Unhandled change of subscribed state: ${id} changed to ${state.val} (ack = ${state.ack})`);
				}
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	_setSetpointTemp(roomID, setpointTemp) {
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/soll/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		if (typeof setpointTemp === 'number' && isFinite(setpointTemp)) {

			setpointTemp = Math.trunc((Math.round(setpointTemp * 8) / 8) * 100) / 100;
			form.append("soll", setpointTemp);

			this.log.debug(`_setSetpointTemp: form = "${JSON.stringify(form)}"`);

			(async () => {
				try {
					await got.post(url, { body: form });
					this.log.debug(`Room ${roomID}: Setting setpoint temperature to ${setpointTemp} °C`);
				} catch (error) {
					this.setState("info.connection", false, true);
					this.log.error(`Room ${roomID}: Setting setpoint temperature returned an error "${error}"`);
					// this.log.error(`Room ${roomID}: Setting setpoint temperature returned an error "${error.response ? error.response.body : error}"`);
				}
			})();
		} else {
			this.log.error(`Room ${roomID}: New setpoint temperature is not a number.`);
		}			
	}

	_setTargetTemp(roomID, targetTemp, targetDuration) {
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/ziel/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);		

		if (typeof targetTemp === 'number' && isFinite(targetTemp)) {
			// According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
			// We therefore need to round the targetTemp to that value (22.1 => 22.12)
			targetTemp = Math.trunc((Math.round(targetTemp * 8) / 8) * 100) / 100;

			form.append("ziel", targetTemp);

			if (typeof targetTemp === 'number' && isFinite(targetTemp)) {
				// duration can either be set directly (as a value in minutes) or to default duration (if value is 0)

				form.append("duration", targetDuration > 0 ? Math.round(targetDuration) : "default");

				this.log.debug(`_setTargetTemp: form = "${JSON.stringify(form)}"`);

				(async () => {
					try {
						await got.post(url, { body: form });
						this.log.debug(`Room ${roomID}: Setting target temperature to ${targetTemp} °C for ${targetDuration} minutes`);
					} catch (error) {
						this.setState("info.connection", false, true);

						if (error instanceof HTTPError) {
							this.log.error(`Room ${roomID}: Setting target temperature returned an error: ${error.response?.body || error.message}`);
						} else if (error instanceof Error) {
							// Generic Error handling
							this.log.error(`Room ${roomID}: Setting target temperature returned an error: ${error.message}`);
						} else {
							// Fallback for unknown errors
							this.log.error(`Room ${roomID}: Setting target temperature returned an unknown error: ${String(error)}`);							
						}
					}
				})();
			} else {
				this.log.error(`Room ${roomID}: Duration for setting of target temperature is not a number.`);
			}
		} else {
			this.log.error(`Room ${roomID}: New target temperature is not a number.`);
		}
	}

	_setActualTemp(roomID, sensorID, actualTemp) {
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/set/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		// [FIXME] SensorID should be checked for validity
		form.append("sensorid", sensorID);

		if (typeof actualTemp === 'number' && isFinite(actualTemp)) {
			// According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
			// We therefore need to round the actualTemp to that value (22.1 => 22.12)
			actualTemp = Math.trunc((Math.round(actualTemp * 8) / 8) * 100) / 100;
			form.append("value", actualTemp);

			this.log.silly(`_setActualTemp: form = "${JSON.stringify(form)}"`);

			(async () => {
				try {
					await got.post(url, { body: form });
					this.log.debug(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} to ${actualTemp} °C`);
				} catch (error) {
					this.setState("info.connection", false, true);

					if (error instanceof HTTPError) {
						this.log.error(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an error: ${error.response?.body || error.message}`);
					} else if (error instanceof Error) {
						// Generic Error handling
						this.log.error(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an error: ${error.message}`);
					} else {
						// Fallback for unknown errors
						this.log.error(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an unknown error: ${String(error)}`);
					}
				}
			})();
		} else {
			this.log.error(`Room ${roomID}: Actual temperature for sensor "${sensorID}" is not a number.`);
		}
	}

	_setOffsetTemp(roomID, apiID, offsetTemp) {
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/roomoffset/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);		

		form.append("offset_name", apiID);
		
		if (typeof offsetTemp === 'number' && isFinite(offsetTemp)) {
			// According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
			// We therefore need to round the offsetTemp to that value (22.1 => 22.12)
			offsetTemp = Math.trunc((Math.round(offsetTemp * 8) / 8) * 100) / 100;
			form.append("offset", offsetTemp);

			this.log.debug(`_setOffsetTemp: form = "${JSON.stringify(form)}"`);

			(async () => {
				try {
					const { body, statusCode } = await got.post(url, { body: form });
					this.log.debug(`Room ${roomID}: Setting offset temperature for offset ${apiID} to ${offsetTemp} °C`);
				} catch (error) {
					this.setState("info.connection", false, true);
					this.log.error(`Room ${roomID}: Setting offset temperature for offset "${apiID}" returned an error "${error}"`);
				}
			})();
		} else {
			this.log.error(`Room ${roomID}: New offset temperature for offset "${apiID}" is not a number.`);
		}

	}

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Controme(options);
} else {
	// otherwise start the instance directly
	new Controme();
}