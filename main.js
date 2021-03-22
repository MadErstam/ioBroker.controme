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
		return Math.round(
			this * Math.pow(10, decimals)
		) / Math.pow(10, decimals);
	};
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
	 * Is called when databases are connected and this received configuration.
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

		// check the received configuration values for validity
		if (this.config.interval < 15) {
			this.log.error("Update interval is less than 15 seconds. Set update interval to 15 seconds.");
			this.config.interval = 15;
		}

		this.log.debug(`Controme URL: ${this.config.url}; houseID: ${this.config.houseID}; update interval: ${this.config.interval}`);

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

			// Read room structure and create all required objects
			try {

				const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/rooms/";
				const response = await got(url);

				// response JSON contains hierarchical information starting with floors and rooms on these floors
				// we need to iterate through the floors and rooms and create the required structures
				// rooms will be our devices

				const body = JSON.parse(response.body);
				// this.log.silly(`Rooms response from Controme mini server: "${JSON.stringify(body)}"`);

				for (const floor in body) {
					if (Object.prototype.hasOwnProperty.call(body, floor)) {
						for (const room in body[floor].raeume) {
							if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
								this._createObjectsForRoom(body[floor].raeume[room]);
							}
						}
					}
				}
				this.log.debug(`Creating room structure from Controme mini server finished successfully`);
			} catch (error) {
				this.log.error(`Creating room structure from Controme mini server finished with error "${error.response.body}"`);
			}

			try {
				const url = "http://" + this.config.url + "/get/json/v1/1/temps/";
				const response = await got(url);

				const body = JSON.parse(response.body);

				for (const floor in body) {
					if (Object.prototype.hasOwnProperty.call(body, floor)) {
						for (const room in body[floor].raeume) {
							if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
								this._createOffsetsForRoom(body[floor].raeume[room]);

								for (const sensor in body[floor].raeume[room].sensoren) {
									if (Object.prototype.hasOwnProperty.call(body[floor].raeume[room].sensoren, sensor)) {
										this._createSensorsForRoom(body[floor].raeume[room].id, body[floor].raeume[room].sensoren[sensor]);
									}
								}
							}
						}
					}
				}
				// the connection indicator is updated when the connection was successful
				this.log.debug(`Creating data objects for offsets and sensors finished successfully`);
				this.setStateAsync("info.connection", true, true);
			} catch (error) {
				// when an error is received, the connection indicator is updated accordingly
				this.setStateAsync("info.connection", false, true);
				this.log.error(`Creating data objects for offsets and sensors finished with error "${error.response.body}"`);
			}

			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { forceReInit: false } });
			} catch (e) {
				this.log.error(`Could not set forceReinit to false: ${e.message}`);
			}

		}


		// Start polling temperature data from the server in the defined update interval
		this.updateInterval = setInterval(() => {
			this.log.debug("Polling temperature data from mini server");
			const url = "http://" + this.config.url + "/get/json/v1/1/temps/";
			(async () => {
				try {
					const response = await got(url);

					const body = JSON.parse(response.body);
					// this.log.silly(`Temps response from Controme mini server: "${JSON.stringify(body)}"`);

					for (const floor in body) {
						if (Object.prototype.hasOwnProperty.call(body, floor)) {
							for (const room in body[floor].raeume) {
								if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
									this._updateRoom(body[floor].raeume[room]);
									this._updateOffsetsForRoom(body[floor].raeume[room]);
									this._updateSensorsForRoom(body[floor].raeume[room]);
								}
							}
						}
					}
					// the connection indicator is updated when the connection was successful
					this.setStateAsync("info.connection", true, true);
				} catch (error) {
					// when an error is received, the connection indicator is updated accordingly
					this.setStateAsync("info.connection", false, true);
					this.log.error(`Polling temperature data from Controme mini server finished with error "${error.response.body}"`);
				}
			})();

		}, this.config.interval * 1000);

		// Subscribe to all states that can be written to
		this.subscribeStates("*.setpointTemperature");
		this.subscribeStates("*.sensors.*.actualTemperature");
		this.subscribeStates("*.offsets.*");

		this.setState("info.connection", true, true);

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
		return Promise.all(promises);
	}

	isEmpty(object) {
		for (var i in object) {
			return false;
		}
		return true;
	}

	_createApiOffsetsForRoom(room) {
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
								this.log.silly(`Creating objects for room ${room.id}: Offset ${offset}.${offset_item}`);
								promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + offset + "." + offset_item, { type: "state", common: { name: room.name + " offset " + offset + " " + offset_item, type: "number", unit: "°C", role: "value", read: true, write: false }, native: {} }));
							}
						}
					} else if (offset == "api") {
						// for an empty offset object "api", we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
						// this.log.silly(`Creating object structure for offset object ${offset}`);
						this.log.silly(`Creating objects for room ${room.id}: Offset ${offset}.api`);
						promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api", { type: "channel", common: { name: room.name + " offset api" }, native: {} }));
						promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api.api", { type: "state", common: { name: room.name + " offset api api", type: "number", unit: "°C", role: "value", read: true, write: true }, native: {} }));
					}
				}
			}
		}
		// Some servers do not include an api module, so the read/write states are not created. Check if "api" exists, if not, create it
		if (typeof (room.offsets["api"]) === "undefined") {
			// for the offset object api, we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
			// this.log.silly(`Creating object structure for offset object ${offset}`);
			this.log.info(`Creating objects for room ${room.id}: Offset api.api`);
			promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api", { type: "channel", common: { name: room.name + " offset api"}, native: {} }));
			promises.push(this.setObjectNotExistsAsync(room.id + ".offsets.api.api", { type: "state", common: { name: room.name + " offset api api", type: "number", unit: "°C", role: "value", read: true, write: true }, native: {} }));
		}
		return Promise.all(promises);
	}

	_createSensorsForRoom(roomID, sensor) {
		const promises = [];
		this.log.silly(`Creating objects for room ${roomID}: Sensor ${sensor.name} (${sensor.beschreibung})`);
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
				this.log.silly(`${room.id}.sensors.${room.sensoren[sensor].name}.isRoomTemperatureSensor: ${room.sensoren[sensor].raumtemperatursensor}`);
				promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".isRoomTemperatureSensor", room.sensoren[sensor].raumtemperatursensor, true));
				// sensor.wert can be either an object or a float
				if (typeof (room.sensoren[sensor].wert) === "object") {
					//  {"raumtemperatursensor":true,"letzte_uebertragung":"18.03.2021 18:23","name":"05:90:22:a2","wert":{"Helligkeit":null,"Relative Luftfeuchte":null,"Bewegung":null,"Temperatur":21.80392156862745}
					this.log.silly(`Updating room ${room.id}: Sensor ${room.sensoren[sensor].name} (${room.sensoren[sensor].beschreibung}) to ${room.sensoren[sensor].wert.Temperatur} °C`);
					promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", parseFloat(room.sensoren[sensor].wert.Temperatur).round(2), true));
				} else {
					this.log.silly(`Updating room ${room.id}: Sensor ${room.sensoren[sensor].name} (${room.sensoren[sensor].beschreibung}) to ${parseFloat(room.sensoren[sensor].wert).round(2)} °C`);
					promises.push(this.setStateChangedAsync(room.id + ".sensors." + room.sensoren[sensor].name + ".actualTemperature", parseFloat(room.sensoren[sensor].wert).round(2), true));
				}
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