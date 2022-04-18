"use strict";

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
const got = require("got");
const formData = require("form-data");

if (!Number.prototype.round) {
	Number.prototype.round = function (decimals) {
		if (typeof decimals === "undefined") {
			decimals = 0;
		}
		return Math.round(this * Math.pow(10, decimals)) / Math.pow(10, decimals);
	}
}

function decrypt(key, value) {
	let result = '';
	for (let i = 0; i < value.length; ++i) {
		result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
	}
	return result;
}

class Controme extends utils.adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "controme",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		if (this.supportsFeature && this.supportsFeature("PLUGINS")) {
			this.getForeignObject("system.config", (err, obj) => {
				if (!this.supportsFeature || !this.supportsFeature("ADAPTER_AUTO_DECRYPT_NATIVE")) {
					if (obj && obj.native && obj.native.secret) {
						//noinspection JSUnresolvedVariable
						this.config.password = decrypt(obj.native.secret, this.config.password);
					} else {
						//noinspection JSUnresolvedVariable
						this.config.password = decrypt("Zgfr56gFe87jJOM", this.config.password);
					}
				}
			});
		}

		const pollInterval = parseInt(this.config.interval) < 15 ? 15 : parseInt(this.config.interval);

		this.log.debug(`Controme URL: ${this.config.url}; houseID: ${this.config.houseID}; update interval: ${pollInterval}; warnOnNull: ${this.config.warnOnNull}`);


		if (this.config.forceReInit) {

			try {
				const objects = await this.getAdapterObjectsAsync();

				for (const object in objects) {
					if (Object.prototype.hasOwnProperty.call(objects, object)) {
						await this.delForeignObjectAsync(object);
					}
				}
				this.log.debug(`Purging object structure finished successfully`);
			} catch (error) {
				this.log.error(`Purging object structure failed with ${error}`);
			}

			this.log.debug(`Creating data objects after purge`);
			await this._createObjects();

			// Set foreceReInit to false after re-initialization to avoid recreating the object structure on each adapter restart
			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { forceReInit: false } });
			} catch (error) {
				this.log.error(`Could not set forceReinit to false: ${error}`);
			}

		}

		this._updateIntervalFunction();

		// Poll temperature data from the server in the defined update interval
		this.updateInterval = setInterval(this._updateIntervalFunction.bind(this), pollInterval * 1000);

		// Subscribe to all states that can be written to
		this.subscribeStates("*.setpointTemperature");
		this.subscribeStates("*.sensors.*.actualTemperature");
		this.subscribeStates("*.offsets.*");

		this.setState("info.connection", true, true);

	}

	_updateIntervalFunction() {
		this._pollRoomTemps();
		this._pollOuts();
	}

	async _pollRoomTemps() {
		// Poll data from temps API
		this.log.debug("Polling temperature data from mini server");
		let body;

		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/temps/";
			const response = await got(url);
			body = JSON.parse(response.body);
		} catch (error) {
			this.setState("info.connection", false, true);
			this.log.error(`Polling temperature data from Controme mini server finished with error "${error}"`);
		}

		this.log.silly(`Temps response from Controme mini server: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body, floor)) {
				for (const room in body[floor].raeume) {
					if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
						this.log.silly(`Processing room ${body[floor].raeume[room].id}`);
						this._updateRoom(body[floor].raeume[room]);

						// Controme deletes offsets that have been set via the api; we need to check which offsets still exist and delete those that do no longer exist
						this._updateOffsetStatesForRoom(body[floor].raeume[room]);

						// update offset and sensor values
						this._updateOffsetsForRoom(body[floor].raeume[room]);
						this._updateSensorsForRoom(body[floor].raeume[room]);
						this.log.silly(`Finished processing room ${body[floor].raeume[room].id}`);
					}
				}
			}
		}
		this.setState("info.connection", true, true);
	}

	async _pollOuts() {
		// Poll data from outs API
		this.log.debug("Polling output data from mini server");
		let body;
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/outs/";
			const response = await got(url);
			body = JSON.parse(response.body);
		} catch (error) {
			// when an error is received, the connection indicator is updated accordingly
			this.setState("info.connection", false, true);
			this.log.error(`Polling outputs data from Controme mini server finished with error "${error}"`);
		}

		this.log.silly(`Outs response from Controme mini server: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body, floor)) {
				for (const room in body[floor].raeume) {
					if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
						this.log.silly(`Processing outputs for room ${body[floor].raeume[room].id}`);

						this._updateOutputsForRoom(body[floor].raeume[room]);

						this.log.silly(`Finished processing room ${body[floor].raeume[room].id}`);
					}
				}
			}
		}
		// the connection indicator is updated when the connection was successful
		this.setState("info.connection", true, true);
	}

	_updateOffsetStatesForRoom(room) {
		// Controme deletes offsets that have been set via the api; we need to check which offsets still exist and delete those that do no longer exist
		// Get all offset states (states in channel offset) of the respective room and check if these are still included in the temps API response
		this.getStatesOf("controme.0." + room.id, "offsets", (err, obj) => {										
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
								this.log.debug(`Deleting offset state ${this.namespace}.${roomID}.${offsetChannel}.${offsetState}, since it does not exist in API response`);
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

	async _createObjects() {
		this.log.debug(`  Creating room, offset and sensor objects`);
		// Read temp API and create all required objects (rooms and sensors)
		let body;
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/temps/";
			const response = await got(url);
			body = JSON.parse(response.body);
		} catch (error) {
			this.log.error(`Polling temps API from mini server to create data objects for rooms, offsets and sensor failed failed with error "${error}"`);
		}
	
		// response JSON contains hierarchical information starting with floors and rooms on these floors
		// followed by offsets and sensors for each room
		// we need to iterate through the floors and rooms and create the required structures
		// rooms will be our devices

		this.log.silly(`Temps response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
				const rooms = body[floor].raeume;
				for (const room in rooms) {
					if (Object.prototype.hasOwnProperty.call(rooms, room)) {
						this._createObjectsForRoom(body[floor].raeume[room]);
						this._createOffsetsForRoom(body[floor].raeume[room]);

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

		this.log.debug(`  Creating out objects  started`);
		try {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/outs/";
			const response = await got(url);
			body = JSON.parse(response.body);
		} catch (error) {
			this.log.error(`Polling outs API from mini server to create data objects for outputs failed failed with error "${error}"`);
		}
	
		// response JSON contains hierarchical information starting with floors and rooms on these floors
		// followed by outputs for each room
		// we need to iterate through the floors and rooms and add the required output structures to the already created rooms

		this.log.silly(`Outs response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);

		for (const floor in body) {
			if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
				const rooms = body[floor].raeume;
				for (const room in rooms) {
					if (Object.prototype.hasOwnProperty.call(rooms[room], 'ausgang')) {
						const outputs = rooms[room].ausgang;
						for (const [key, value] of Object.entries(outputs)) {
							this.log.silly(`Creating output objects for room ${rooms[room].id}: Output ${key}`);
							this.setObjectNotExistsAsync(rooms[room].id + ".outputs." + key, { type: "state", common: { name: rooms[room].name + " outputs " + key, type: "string", role: "value", read: true, write: false }, native: {} } );
						}
					}
				}
			}
		}

		// the connection indicator is updated when the connection was successful
		this.log.debug(`Creating data objects for rooms, outputs offsets and sensors finished successfully`);
		this.setStateAsync("info.connection", true, true);
	}

	_createObjectsForRoom(room) {
		const promises = [];
		this.log.silly(`Creating objects for room ${room.id} (${room.name}): Basic object structure`);
		promises.push(this.setObjectNotExistsAsync(room.id.toString(), { type: "device", common: { name: room.name }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".actualTemperature", { type: "state", common: { name: room.name + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setpointTemperature", { type: "state", common: { name: room.name + " setpoint temperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temperatureOffset", { type: "state", common: { name: room.name + " temperature offset", type: "number", unit: "°C", role: "value", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".sensors", { type: "channel", common: { name: room.name + " sensors" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".offsets", { type: "channel", common: { name: room.name + " offsets" }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".outputs", { type: "channel", common: { name: room.name + " outputs" }, native: {} }));
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
						// this.log.silly(`Creating object structure for offset object ${offset}`);
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
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name + ".actualTemperature", { type: "state", common: { name: sensor.beschreibung + " actual temperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: true }, native: {} }));
		return Promise.all(promises);
	}

	_updateRoom(room) {
		const promises = [];
		this.log.silly(`Updating room ${room.id} (${room.name}): Actual temperature ${parseFloat(room.temperatur).round(2)} °C, setpoint temperature ${parseFloat(room.solltemperatur).round(2)} °C, temperature offset ${parseFloat(room.total_offset).round(2)} °C`);
		promises.push(this.setStateChangedAsync(room.id + ".actualTemperature", parseFloat(room.temperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".setpointTemperature", parseFloat(room.solltemperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".temperatureOffset", parseFloat(room.total_offset).round(2), true));
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
								this.log.silly(`Updating room ${room.id}: Offset ${offset}.${offset_item} to ${parseFloat(room.offsets[offset][offset_item]).round(2)} °C`);
								promises.push(this.setStateChangedAsync(room.id + ".offsets." + offset + "." + offset_item, parseFloat(room.offsets[offset][offset_item]).round(2), true));
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
								promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", parseFloat(room.sensoren[sensor].wert.Temperatur).round(2), true));
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
								this.log.silly(`Updating room ${room.id}: Sensor ${room.sensoren[sensor].name} (${room.sensoren[sensor].beschreibung}) to ${parseFloat(room.sensoren[sensor].wert).round(2)} °C`);
								promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", parseFloat(room.sensoren[sensor].wert).round(2), true));
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
			clearInterval(this.updateInterval);
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
					if (roomID !== null) {
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
					if (roomID !== null && sensorID !== null) {
						this.log.debug(`Room ${roomID[1]}: Calling setActualTemp(${roomID[1]}, ${sensorID[1]}, ${state.val})`);
						this._setActualTemp(roomID[1], sensorID[1], state.val);
					} else {
						this.log.error(`Change of subscribed actualTemperature state ${id} to ${state.val} °C (ack = ${state.ack}) failed`);
					}
				} else if (id.includes(".offsets.")) {
					// 	this.subscribeStates("*.offsets.api.*");
					// extract the apiID and sensorID from id
					const roomID = id.match(/^controme\.\d\.(\d+)/);
					const apiID = id.match(/offsets\.[^.]+\.(.+)/);
					if (roomID !== null && apiID !== null) {
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
		this.log.debug(`Room ${roomID}: Setting setpoint temperature to ${setpointTemp} °C`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/soll/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		// [FIXME] SetpointTemp should be checked for validity
		form.append("soll", setpointTemp);

		(async () => {
			try {
				await got.post(url, { body: form });
			} catch (error) {
				this.log.error(`Room ${roomID}: Setting setpoint temperature returned an error "${error}"`);
			}
		})();
	}

	_setTargetTemp(roomID, targetTemp, targetDuration) {
		this.log.debug(`Room ${roomID}: Setting target temperature to ${targetTemp} °C for ${targetDuration} minutes`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/ziel/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		// [FIXME] TargetTemp and Duration should be checked for validity
		form.append("ziel", targetTemp);
		// duration can either be set directly or to default duration
		form.append("duration", targetDuration);

		(async () => {
			try {
				await got.post(url, { body: form });
			} catch (error) {
				this.log.error(error);
			}
		})();
	}

	_setActualTemp(roomID, sensorID, actualTemp) {
		this.log.debug(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} to ${actualTemp} °C`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/set/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		// [FIXME] SensorID and Value should be checked for validity
		form.append("sensorid", sensorID);
		form.append("value", actualTemp);

		(async () => {
			try {
				const { body } = await got.post(url, { body: form });
				if (body != "") {
					this.log.error(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an unexpected response "${body}"`);
				}
			} catch (error) {
				this.log.error(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an error "${error}"`);
			}
		})();
	}

	_setOffsetTemp(roomID, apiID, offsetTemp) {
		this.log.debug(`Room ${roomID}: Setting offset temperature for offset ${apiID} to ${offsetTemp} °C`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/roomoffset/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		form.append("offset_name", apiID);
		// [FIXME] Offset should be checked for validity
		form.append("offset", offsetTemp);

		(async () => {
			try {
				await got.post(url, { body: form });
			} catch (error) {
				this.log.error(`Room ${roomID}: Setting offset temperature for offset ${apiID} returned an error "${error}"`);
			}
		})();
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