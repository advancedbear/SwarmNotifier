require('dotenv').config();
const express = require('express');
const session = require('express-session')
const path = require("path");
const fs = require("fs")
const sqlite3 = require("sqlite3");
const axios = require("axios").default;
const { TwitterApi } = require('twitter-api-v2')
const app = express();
const router = express.Router();
const port = 3000;

const logger = (level, message) => {
    switch(level) {
        case 0:
            console.log(`[INFO]  ${message}`)
            break
        case 1:
            console.log(`[WARN]  ${message}`)
            break
        case 2:
            console.error(`[ERROR] ${message}`)
            break
        case 3:
            console.error(`[CRIT]  ${message}`)
            break
        default: 
            if(process.env.DEBUGMODE == '1') {
                console.log(`[DEBUG] ${message}`)
            }
    }
}

const db = new sqlite3.Database(path.resolve(__dirname, "main.db"), (err) => {
    if (err) {
        logger(2, "database error: " + err.message);
    } else {
        db.serialize(() => {
            //table生成（無ければ）
            db.run("create table if not exists members( \
                id integer primary key, \
                fsq_token nverchar(50), \
                x_token nverchar(100), \
                x_secret nverchar(100) \
            )", (err) => {
                if (err) {
                    logger(2, "table error: " + err.message);
                }
            });
        });
    }
});
app.set("view engine", "ejs");
app.set("views", "views");
app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));
app.use(session({
    secret: process.env.NODE_SESSION_KEY,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 60 * 60 * 1000 }
}))

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"))
})

app.use(
    router.get("/registered", (req, res, next) => {
        self = {
            x_user: req.query.x_id || "NOT LOGGED IN",
            fsq_user: req.query.fsq_id || "NOT LOGGED IN",
            status: req.query.status || "disconnected"
        }
        res.render("registered", self);
    })
);

app.post('/webhook', (req, res) => {
    if (!req.body.user) logger(1, 'Request is not Foursquare Webhook.')
    logger(0, 'Received webhook request from user_id:' + JSON.parse(req.body.user).id);

    db.get("select * from members where id = ?", JSON.parse(req.body.user).id, (err, row) => {
        if (err) {
            res.status(400).send('Webhook received failed!')
        } else {
            logger(99, JSON.stringify(row))
            if (row) {
                setTimeout(() => {
                    axios.get(`https://api.foursquare.com/v2/checkins/${JSON.parse(req.body.checkin).id}`, {
                        params: {
                            v: "20241201",
                            oauth_token: row.fsq_token
                        }
                    }).then((response) => {
                        const x_client = new TwitterApi({
                            appKey: process.env.X_CLIENT_ID,
                            appSecret: process.env.X_CLIENT_SECRET,
                            accessToken: row.x_token,
                            accessSecret: row.x_secret
                        });
                        checkin = response.data.response.checkin
                        logger(99, JSON.stringify(checkin))
                        if (!checkin['shares']) {
                            logger(0, "Webhook does not want to share twitter.")
                            res.status(200).send('Webhook received successfully!')
                            return
                        }
                        location = ""
                        if (checkin.venue.location.state) {
                            location = `in ${checkin.venue.location.state} ${checkin.venue.location.city ? checkin.venue.location.city : ""}`
                        }
                        if (checkin['shout']) {
                            post_msg = `I'm at ${checkin.venue.name} ${location}\n${checkin.checkinShortUrl}\n\n${checkin.shout}`
                        } else {
                            post_msg = `I'm at ${checkin.venue.name} ${location}\n${checkin.checkinShortUrl}`
                        }
                        if (checkin.photos.count > 0) {
                            const photos = checkin.photos.items.slice(0, 4)
                            let mediaIds = [];
                            photos.reduce((prevPromise, p_url) => {
                                return prevPromise.then(() => {
                                    const url = `${p_url.prefix}original${p_url.suffix}`;
                                    logger(0, `Downloading check-in photo: ${url}`);
                                    return axios.get(url, {
                                        responseType: 'arraybuffer',
                                        headers: { 'Content-Type': 'image/jpeg' }
                                    }).then(response => {
                                        logger(0, `Downloaded check-in photo: ${url}`);
                                        return x_client.v1.uploadMedia(
                                            Buffer.from(response.data),
                                            { mimeType: 'image/jpeg' }
                                        );
                                    }).then(mediaId => {
                                        logger(0, `Uploaded check-in photo: ${url}, mediaId=${mediaId}`);
                                        mediaIds.push(mediaId);
                                    });
                                });
                            }, Promise.resolve())
                                .then(() => {
                                    return x_client.v2.post('tweets', {
                                        text: post_msg,
                                        media: { media_ids: mediaIds }
                                    }, { fullResponse: true });
                                })
                                .then(result => {
                                    logger(0, `Twitter POST Tweet Rate Limit: ${JSON.stringify(result.rateLimit)}`);
                                    fs.writeFileSync('ratelimit.json', JSON.stringify(result.rateLimit, null, "  "));
                                    res.status(200).send('Webhook received successfully!');
                                })
                                .catch(err => {
                                    logger(2, "Error in posting tweet with media " + err);
                                    res.status(400).send('Webhook received failed!');
                                });

                        } else {
                            x_client.v2.tweet({ text: post_msg })
                                .then((result) => {
                                    logger(0, result)
                                    res.status(200).send('Webhook received successfully!');
                                }).catch((err) => {
                                    logger(2, "post_tweet", err)
                                    res.status(400).send('Webhook received failed!')
                                })
                        }
                    }).catch((err) => {
                        logger(2, err)
                        res.status(400).send('Webhook received failed!')
                    })
                }, 15000)
            } else {
                logger(1, 'User has not been registered.')
                res.status(400).send('Webhook received failed!')
            }
        }
    })
});

app.get('/ratelimit', (req, res) => {
    res.sendFile(path.join(__dirname, "ratelimit.json"))
})

app.get('/register', (req, res) => {
    logger(0, 'Received register request.');
    res.redirect(`https://foursquare.com/oauth2/authenticate?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${process.env.REDIRECT_URL}`)
})

app.get('/login', (req, res) => {
    logger(0, 'Received login request:', req.query);
    if (req.query["code"]) {
        axios.get(`https://foursquare.com/oauth2/access_token`, {
            params: {
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: "authorization_code",
                redirect_uri: process.env.REDIRECT_URL,
                code: req.query.code
            }
        })
            .then((response) => {
                logger(99, JSON.stringify(response.status))
                let oauth_token = response.data.access_token
                axios.get('https://api.foursquare.com/v2/users/self', {
                    params: {
                        v: "20241201",
                        oauth_token: oauth_token
                    }
                }).then((response) => {
                    db.get("select * from members", (err, row) => {
                        logger(99, JSON.stringify(row))
                    })
                    let user_id = response.data.response.user.id
                    req.session.user_id = user_id
                    req.session.fsq_user = response.data.response.user.handle
                    const stmt = db.prepare("insert into members(id,fsq_token) values(?,?) on conflict(id) do update set fsq_token = excluded.fsq_token");
                    stmt.run(user_id, oauth_token, (err, result) => {
                        if (err) {
                            res.status(400).json({
                                "status": "error",
                                "message": err.message
                            });
                            return;
                        } else {
                            res.redirect('/xregister')
                        }
                    })
                }).catch((err) => {
                    res.status(400).json({
                        "status": "error",
                        "message": JSON.stringify(err)
                    });
                })
            })
    }
})

app.get('/xregister', async (req, res) => {
    const userClient = new TwitterApi({
        appKey: process.env.X_CLIENT_ID,
        appSecret: process.env.X_CLIENT_SECRET,
    });
    const authLink = await userClient.generateAuthLink(process.env.X_REDIRECT_URL);
    req.session.oauth_token = authLink.oauth_token
    req.session.oauth_token_secret = authLink.oauth_token_secret
    logger(0, req.session)
    logger(0, authLink.url)
    res.redirect(authLink.url)
})

app.get('/xlogin', async (req, res) => {
    const { oauth_token, oauth_verifier } = req.query;
    const { oauth_token_secret } = req.session;

    if (!oauth_token || !oauth_verifier || !oauth_token_secret) {
        return res.status(400).send('You denied the app or your session expired!');
    }

    const tempClient = new TwitterApi({
        appKey: process.env.X_CLIENT_ID,
        appSecret: process.env.X_CLIENT_SECRET,
        accessToken: oauth_token,
        accessSecret: oauth_token_secret,
    });

    tempClient.login(oauth_verifier)
        .then(({ client: loggedClient, accessToken, accessSecret }) => {
            const stmt = db.prepare("insert into members(id,x_token,x_secret) values(?,?,?) on conflict(id) do update set x_token = excluded.x_token, x_secret = excluded.x_secret");
            stmt.run(req.session.user_id, accessToken, accessSecret, async (err, result) => {
                if (err) {
                    res.redirect(`/registered?status=disconnected`)
                    return;
                } else {
                    res.redirect(`/registered?status=connected&fsq_id=${req.session.fsq_user}&x_id=${(await loggedClient.currentUser()).screen_name}`)
                }
            })
        })
        .catch(() => res.status(403).send('Invalid verifier or access tokens!'));
})

app.listen(port, () => {
    logger(0, `Server is running on port ${port} `);
});