require('dotenv').config();
const express = require('express');
const session = require('express-session')
const path = require("path");
const sqlite3 = require("sqlite3");
const axios = require("axios").default;
const { TwitterApi } = require('twitter-api-v2')
const app = express();
const router = express.Router();
const port = 3000;

const db = new sqlite3.Database("./main.db", (err) => {
    if (err) {
        console.error("database error: " + err.message);
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
                    console.error("table error: " + err.message);
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
    console.log(req.body)
    console.log('Received webhook request from user_id:', JSON.parse(req.body.user).id);
    db.get("select * from members where id = ?", JSON.parse(req.body.user).id, (err, row) => {
        if (err) {
            res.status(400).send('Webhook received failed!')
        } else {
            console.log(row)
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
                        console.log(checkin)
                        if (!checkin.shares['twitter']) {
                            console.log("Webhook does not want to share twitter.")
                            res.status(200).send('Webhook received successfully!')
                            return
                        }
                        if (checkin['shout']) {
                            post_msg = `I'm at ${checkin.venue.name} in ${checkin.venue.location.state} ${checkin.venue.location.city}\n${checkin.checkinShortUrl}\n\n${checkin.shout}`
                        } else {
                            post_msg = `I'm at ${checkin.venue.name} in ${checkin.venue.location.state} ${checkin.venue.location.city}\n${checkin.checkinShortUrl}`
                        }
                        if (checkin.photos.count > 0) {
                            let p_url = checkin.photos.items[0]
                            axios.get(`${p_url.prefix}original${p_url.suffix}`, {
                                'responseType': 'arraybuffer',
                                'headers': {
                                    'Content-Type': 'image/jpeg'
                                }
                            })
                                .then((response) => {
                                    console.log(`${p_url.prefix}original${p_url.suffix} Downloaded.`)
                                    x_client.v1.uploadMedia(Buffer.from(response.data), { mimeType: 'Jpeg' })
                                        .then((mediaId) => {
                                            x_client.v2.tweet({
                                                text: post_msg,
                                                media: { media_ids: [mediaId] }
                                            }).then((result) => {
                                                console.log(result)
                                                res.status(200).send('Webhook received successfully!');
                                            }).catch((err) => {
                                                console.log("post_tweet", err)
                                                res.status(400).send('Webhook received failed!')
                                            })
                                        }).catch((err) => {
                                            console.log("upload media", err)
                                            res.status(400).send('Webhook received failed!')
                                        })
                                }).catch((err) => {
                                    console.log("image download", err)
                                    res.status(400).send('Webhook received failed!')
                                })
                        } else {
                            x_client.v2.tweet({ text: post_msg })
                                .then((result) => {
                                    console.log(result)
                                    res.status(200).send('Webhook received successfully!');
                                }).catch((err) => {
                                    console.log("post_tweet", err)
                                    res.status(400).send('Webhook received failed!')
                                })
                        }
                    }).catch((err) => {
                        console.error(err)
                        res.status(400).send('Webhook received failed!')
                    })
                }, 15000)
            } else {
                console.log('User has not been registered.')
                res.status(400).send('Webhook received failed!')
            }
        }
    })
});

app.get('/register', (req, res) => {
    console.log('Received register request.');
    res.redirect(`https://foursquare.com/oauth2/authenticate?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${process.env.REDIRECT_URL}`)
})

app.get('/login', (req, res) => {
    console.log('Received login request:', req.query);
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
                console.log(response.status)
                let oauth_token = response.data.access_token
                axios.get('https://api.foursquare.com/v2/users/self', {
                    params: {
                        v: "20241201",
                        oauth_token: oauth_token
                    }
                }).then((response) => {
                    db.get("select * from members", (err, row) => {
                        console.log(row)
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
    console.log(req.session)
    console.log(authLink.url)
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
    console.log(`Server is running on port ${port} `);
});