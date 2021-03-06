/*
 * @Project: limitrr
 * @Created Date: Wednesday, October 31st 2018, 2:42:59 pm
 * @Author: Edward Jibson
 * @Last Modified Time: November 17th 2018, 8:03:32 pm
 * @Last Modified By: Edward Jibson
 */
const Redis = require("ioredis");

class limitrr {
    constructor(conf) {
        conf.routes = conf.routes || {};
        conf.routes.default = conf.routes.default || {};
        conf.routes.default.errorMsgs = conf.routes.default.errorMsgs || {};
        //So many ors because compatibility with version 1
        conf.routes.default = {
            "requestsPerExpiry": conf.routes.default.requestsPerExpiry || conf.options.requestsPerExpiry || 100,
            "completedActionsPerExpiry": conf.routes.default.completedActionsPerExpiry || conf.options.completedActionsPerExpiry || 5,
            "expiry": conf.routes.default.expiry || conf.options.expiry || 900,
            "completedExpiry": conf.routes.default.completedExpiry || conf.routes.default.expiry || conf.options.completedExpiry || conf.options.expiry || 900,
            "errorMsgs": {
                "requests": conf.routes.default.errorMsgs.requests || conf.options.errorMsg || "As you have made too many requests, you are being rate limited.",
                "completed": conf.routes.default.errorMsgs.completed || conf.options.errorMsg || "As you performed too many successful actions, you are being rate limited."
            }
        };

        this.options = {
            //Use provided options or if not, revert to default.
            keyName: conf.options.keyName || "limitrr",
            errorStatusCode: conf.options.errorStatusCode || 429,
            catchErrors: conf.options.catchErrors || true
        };

        this.routes = conf.routes;
        this._setDefaultToUndefined(this.routes)
        this.db = new Redis({
            port: conf.redis.port || 6379,
            host: conf.redis.host || "127.0.0.1",
            family: conf.redis.family || 4,
            password: conf.redis.password || "",
            db: conf.redis.db || 0
        });
        this.db.on("error", (err) => {
            if (this.options.catchErrors) {
                this.isConnected = false;
                console.error("[limitrr] Couldn't connect to redis:", err);
            } else {
                throw new Error(err);
            }
        });
    }

    getRoutes() {
        return this.routes;
    }

    getOptions() {
        return this.options;
    }

    getIp() {
        return (req, res, next) => {
            req.realIp =
                req.headers["cf-connecting-ip"] ||
                req.headers["x-forwarded-for"] ||
                req.connection.remoteAddress;
            next();
        };
    }

    limit(obj = {
        "route": "default"
    }) {
        return (req, res, next) => {
            let route;
            if (typeof obj === "string") {
                route = obj;
            } else {
                route = obj.route;
            }
            let {
                test
            } = obj;
            let ip =
                req.headers["cf-connecting-ip"] ||
                req.headers["x-forwarded-for"] ||
                req.connection.remoteAddress;
            if (test) {
                ip = "test";
            }
            this.db.multi()
                .get(`limitrr:${this.options.keyName}:${ip}:${route}:requests`)
                .get(`limitrr:${this.options.keyName}:${ip}:${route}:completed`)
                .ttl(`limitrr:${this.options.keyName}:${ip}:${route}:requests`)
                .ttl(`limitrr:${this.options.keyName}:${ip}:${route}:completed`)
                .exec()
                .then((result) => {
                    this.routes[route] = this.routes[route] || this.routes.default;
                    if (result[2][1] < 0) {
                        result[2][1] = 0;
                    }
                    if (result[3][1] < 0) {
                        result[3][1] = 0;
                    }
                    res.header("X-RateLimit-Limit", this.routes[route].requestsPerExpiry);
                    res.header("X-RateLimit-Remaining", (this.routes[route].requestsPerExpiry - result[0][1] - 1));
                    res.header("X-RateLimit-Reset", parseInt(result[2][1]));
                    res.header("X-RateLimit-Limit-Actions", this.routes[route].completedActionsPerExpiry);
                    res.header("X-RateLimit-Remaining-Actions", (this.routes[route].completedActionsPerExpiry - result[1][1]));
                    res.header("X-RateLimit-Reset-Actions", parseInt(result[3][1]));
                    if (parseInt(result[0][1]) >= this.routes[route].requestsPerExpiry) {
                        return res.status(this.options.errorStatusCode).json({
                            error: this.routes[route].errorMsgs.requests
                        });
                    } else if (parseInt(result[1][1]) >= this.routes[route].completedActionsPerExpiry) {
                        return res.status(this.options.errorStatusCode).json({
                            error: this.routes[route].errorMsgs.completed
                        });
                    } else if (result[0][1]) {
                        this.db.incr(`limitrr:${this.options.keyName}:${ip}:${route}:requests`).then((result) => {
                            if (result.length > 0) {
                                next();
                            } else {
                                next("[limitrr] Keystore returned invalid data.")
                            }
                        }).catch((err) => {
                            this._handleError(err, res);
                        });
                    } else {
                        this.db
                            .multi()
                            .incr(`limitrr:${this.options.keyName}:${ip}:${route}:requests`)
                            .expire(
                                `limitrr:${this.options.keyName}:${ip}:${route}:requests`, this.routes[route].expiry
                            )
                            .exec()
                            .then((result) => {
                                if (result.length > 0) {
                                    next();
                                } else {
                                    next("[limitrr] Keystore returned invalid data.")
                                }
                            })
                            .catch((err) => {
                                this._handleError(err, res);
                            });
                    }
                })
                .catch((err) => {
                    this._handleError(err, res);
                });
        };
    }

    complete(obj, o_route = "default") {
        return new Promise((resolve, reject) => {
            let discriminator;
            if (typeof obj === "string") {
                discriminator = obj;
            } else {
                discriminator = obj.discriminator;
            }
            let {
                route
            } = obj;
            if (!route) {
                route = o_route;
            }
            this.routes[route] = this.routes[route] || this.routes.default;
            this.db
                .multi()
                .incr(
                    `limitrr:${this.options.keyName}:${discriminator}:${route}:completed`
                )
                .expire(
                    `limitrr:${this.options.keyName}:${discriminator}:${route}:completed`, this.routes[route].completedExpiry
                )
                .exec()
                .then((result) => {
                    if (result.length > 0) {
                        resolve(true);
                    } else {
                        reject("Keystore returned invalid data.");
                    }
                })
                .catch((err) => {
                    reject(err);
                });
        });
    }

    get(obj, o_route = "default", o_type = false) {
        return new Promise((resolve, reject) => {
            let discriminator;
            if (typeof obj === "string") {
                discriminator = obj;
            } else {
                discriminator = obj.discriminator;
            }
            let {
                route,
                type
            } = obj;
            if (!route) {
                route = o_route;
            }
            if (!type) {
                type = o_type;
            }
            if (!type) {
                this.db.multi()
                    .get(`limitrr:${this.options.keyName}:${discriminator}:${route}:requests`)
                    .get(`limitrr:${this.options.keyName}:${discriminator}:${route}:completed`)
                    .exec()
                    .then((result) => {
                        if (result.length > 0) {
                            resolve({
                                "requests": (parseInt(result[0][1]) || 0),
                                "completed": (parseInt(result[1][1]) || 0)
                            });
                        } else {
                            reject("Keystore returned invalid data");
                        }
                    }).catch((err) => {
                        reject(err);
                    });
            } else {
                this.db.get(`limitrr:${this.options.keyName}:${discriminator}:${route}:${type}`).then((result) => {
                    resolve(parseInt(result) || 0);
                }).catch((err) => {
                    reject(err);
                });
            }

        });
    }

    reset(obj, o_type = false, o_route = "default") {
        return new Promise((resolve, reject) => {
            let discriminator;
            if (typeof obj === "string") {
                discriminator = obj;
            } else {
                discriminator = obj.discriminator;
            }
            let {
                type,
                route
            } = obj;
            if (!type) {
                type = o_type;
            }
            if (!route) {
                route = o_route;
            }
            if (!type) {
                this.db.multi()
                    .del(`limitrr:${this.options.keyName}:${discriminator}:${route}:requests`)
                    .del(`limitrr:${this.options.keyName}:${discriminator}:${route}:completed`)
                    .exec().then((result) => {
                        if (result.length > 0) {
                            resolve(true);
                        } else {
                            reject("Keystore returned invalid data");
                        }
                    }).catch((err) => {
                        reject(err);
                    });
            } else {
                this.db.del(`limitrr:${this.options.keyName}:${discriminator}:${route}:${type}`).then((result) => {
                    if (result) {
                        resolve(true);
                    } else {
                        reject("Keystore returned invalid data");
                    }
                }).catch((err) => {
                    reject(err);
                });
            }

        });
    }

    _handleError(err, res = false) {
        if (this.options.catchErrors) {
            console.error("[limitrr] Error:", err);
        } else {
            throw new Error(err);
        }
        return res.status(500).json({
            error: "Internal Error"
        });
    }

    _setDefaultToUndefined(obj) {
        return new Promise((resolve) => {
            Object.keys(obj).forEach((obj2, index) => {
                if (index <= Object.keys(obj).length - 1) {
                    obj2 = obj[obj2];
                    Object.keys(this.routes.default).forEach((key) => {
                        if (!obj2[key]) {
                            obj2[key] = this.routes.default[key];
                        }
                    });
                } else {
                    this.routes = obj;
                    resolve(obj);
                }
            });
        });
    }
}

module.exports = limitrr;