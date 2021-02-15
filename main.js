"use strict";

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
// const fs = require("fs");
const got = require("got");
const formData = require("form-data");

Number.prototype.round = function (decimals) {
	return +(Math.round(this + "e+" + decimals) + "e-" + decimals);
};

class Controme extends utils.Adapter {

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

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.log.debug("Controme URL: " + this.config.url + "; HouseID: " + this.config.houseid + "; update interval: " + this.config.interval);
		// this.log.info("Force ReInit: " + this.config.forcereinit);
		// const forceReInit = this.config.forcereinit;
		const forceReInit = false;

		if (forceReInit) {
			this._clearDevices();

			(async () => {
				const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseid + "/rooms/";
				try {
					const response = await got(url);

					// response JSON contains hierarchical information starting with floors and rooms on these floors
					// we need to iterate through the floors and rooms and create the required structures
					// rooms will be our devices	

					const body = JSON.parse(response.body);
					this.log.silly("Rooms from Controme mini server: " + JSON.stringify(body));

					for (let floor in body) {
						if (body.hasOwnProperty(floor)) {
							let floorData = body[floor];
							for (let room in body[floor].raeume) {
								if (body[floor].raeume.hasOwnProperty(room)) {
									let roomData = body[floor].raeume[room];
									this._createObjectsForRoom(roomData);
								}
							}
						}
					}

				} catch (error) {
					this.log.error(error.response.body);
				}
			})();
		}

		this.updateInterval = setInterval(() => {
			this.log.debug("Polling temperature data from mini server");
			const url = "http://" + this.config.url + "/get/json/v1/1/temps/";
			(async () => {
				try {
					const response = await got(url);

					const body = JSON.parse(response.body);
					this.log.silly("Update response from Controme mini server: " + JSON.stringify(body));

					for (let floor in body) {
						if (body.hasOwnProperty(floor)) {
							let floorData = body[floor];
							for (let room in body[floor].raeume) {
								if (body[floor].raeume.hasOwnProperty(room)) {
									let roomData = body[floor].raeume[room];
									// this.log.info(room + ": " + JSON.stringify(roomData));
									this._updateRoom(roomData);
								}
							}
						}
					}

				} catch (error) {
					this.log.info(error.response.body);
				}
			})();

		}, this.config.interval * 1000);

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		// this.subscribeStates("testVariable");
		// You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		this.subscribeStates("*.set_point_temperature");
		// Or, if you really must, you can also watch all states. Don"t do this if you don"t need to. Otherwise this will cause a lot of unnecessary load on the system:
		// this.subscribeStates("*");

		this.setState("info.connection", true, true);


		/*
			setState examples
			you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		/*
		// the variable testVariable is set to true as command (ack=false)
		await this.setStateAsync("testVariable", true);
	
		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setStateAsync("testVariable", { val: true, ack: true });
	
		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setStateAsync("testVariable", { val: true, ack: true, expire: 30 });
	
		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync("admin", "iobroker");
		this.log.info("check user admin pw iobroker: " + result);
	
		result = await this.checkGroupAsync("admin", "admin");
		this.log.info("check group user admin group admin: " + result);
		*/
	}

	_clearDevices() {
		this.log.debug("Clearing all rooms");
		(async () => {
			try {
				const objects = await this.getAdapterObjectsAsync();

				for (let object in objects) {
					if (objects.hasOwnProperty(object)) {
						let d = objects[object];
						await this.delForeignObjectAsync(object);
					}
				}

			} catch (error) {
				this.log.error(error);
			}
		})();
	};

	_createObjectsForRoom(room) {
		let promises = [];
		promises.push(this.setObjectNotExistsAsync(room.id.toString(), { type: 'device', common: { name: room.name }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".actual_temperature", { type: "state", common: { name: room.name + ".actualTemperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".set_point_temperature", { type: "state", common: { name: room.name + ".setPointTemperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temperatureOffset", { type: "state", common: { name: room.name + ".temperatureOffset", type: "number", unit: "°C", read: true, write: false }, native: {} }));
		return Promise.all(promises);
	};

	_updateRoom(room) {
		let promises = [];
		this.log.silly("Updating room " + room.id + " (" + room.name + ")");
		promises.push(this.setStateChangedAsync(room.id + ".actual_temperature", parseFloat(room.temperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".set_point_temperature", parseFloat(room.solltemperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".temperatureOffset", parseFloat(room.total_offset).round(2), true));
		return Promise.all(promises);
	};

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

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
			// The state was changed			
			this.log.info("Room ${id.parent}: state ${id} changed: ${state.val} (ack = ${state.ack})");
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	_setPointTemp(roomID, temperature) {
		const url = "http://" + this.config.url + "/set/json/v1/1/soll/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password": this.config.password);
		form.append("soll": setpointTemp };

		(async () => {
			try {
				const response = await got.post(url, { body: form });

				const body = JSON.parse(response.body);
				this.log.silly("Update response from Controme mini server: " + JSON.stringify(body));

				return 0;

			} catch (error) {
				this.log.info(error.response.body);

				return 1;
			}

		});
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

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