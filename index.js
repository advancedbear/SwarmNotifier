require('dotenv').config();
const express = require('express');
const session = require('express-session')
const sqlite3 = require("sqlite3");
const axios = require("axios").default;
const { TwitterApi } = require('twitter-api-v2')
const userClient = new TwitterApi({
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
    // appKey: process.env.X_CLIENT_ID,
    // appSecret: process.env.X_CLIENT_SECRET,
    // accessToken: process.env.X_ACCESS_TOKEN,
    // accessSecret: process.env.X_ACCESS_SECRET,
});
const app = express();
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
                x_token nverchar(50) \
            )", (err) => {
                if (err) {
                    console.error("table error: " + err.message);
                }
            });
        });
    }
});

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

app.post('/webhook', (req, res) => {
    console.log(req.body)
    console.log('Received webhook request from user_id:', JSON.parse(req.body.user).id);
    db.get("select * from members where id = ?", JSON.parse(req.body.user).id, (err, row) => {
        if (err) {
            res.status(400).send('Webhook received failed!')
        } else {
            console.log(row)
            if (row) {
                axios.get(`https://api.foursquare.com/v2/checkins/${JSON.parse(req.body.checkin).id}`, {
                    params: {
                        v: "20241201",
                        oauth_token: row.fsq_token
                    }
                }).then((response) => {
                    checkin = response.data.response.checkin
                    console.log(checkin)
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
                                const x_client = new TwitterApi(row.x_token);
                                x_client.v1.verifyCredentials()
                                x_client.v1.uploadMedia(Buffer.from(response.data),  {mimeType: 'Jpeg'})
                                    .then((mediaId) => {
                                        x_client.v2.tweet({
                                            text: post_msg,
                                            media: mediaId
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
                    }
                }).catch((err) => {
                    console.error(err)
                    res.status(400).send('Webhook received failed!')
                })
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
                    // console.log(response.data)
                    db.get("select * from members", (err, row) => {
                        console.log(row)
                    })
                    let user_id = response.data.response.user.id
                    req.session.user_id = user_id
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
    const { url, codeVerifier, state } = userClient.generateOAuth2AuthLink(process.env.X_REDIRECT_URL, { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
    req.session.codeVerifier = codeVerifier
    req.session.state = state
    console.log(req.session)
    console.log(url)
    res.redirect(url)
})

app.get('/xlogin', async (req, res) => {
    console.log(req.query)
    console.log(req.session.codeVerifier)
    // Extract state and code from query string
    const { state, code } = req.query;
    // Get the saved codeVerifier from session
    const { codeVerifier, state: sessionState } = req.session;

    if (!codeVerifier || !state || !sessionState || !code) {
        return res.status(400).send('You denied the app or your session expired!');
    }
    if (state !== sessionState) {
        return res.status(400).send('Stored tokens didnt match!');
    }

    // Obtain access token
    const client = new TwitterApi({ clientId: process.env.X_CLIENT_ID, clientSecret: process.env.X_CLIENT_SECRET });

    client.loginWithOAuth2({ code, codeVerifier, redirectUri: process.env.X_REDIRECT_URL })
        .then(async ({ client: loggedClient, accessToken, refreshToken, expiresIn }) => {
            // {loggedClient} is an authenticated client in behalf of some user
            // Store {accessToken} somewhere, it will be valid until {expiresIn} is hit.
            // If you want to refresh your token later, store {refreshToken} (it is present if 'offline.access' has been given as scope)
            // Example request
            const { data: userObject } = await loggedClient.v2.me();

            const stmt = db.prepare("insert into members(id,x_token) values(?,?) on conflict(id) do update set x_token = excluded.x_token");
            stmt.run(req.session.user_id, accessToken, (err, result) => {
                if (err) {
                    res.status(400).json({
                        "status": "error",
                        "message": err.message
                    });
                    return;
                } else {
                    res.status(200).json({
                        "status": "ok",
                        "Foursquare_UserID": req.session.user_id,
                        "x_UserID": userObject.name
                    });
                }
            })
        })
        .catch(() => res.status(403).send('Invalid verifier or access tokens!'));
})

app.listen(port, () => {
    console.log(`Server is running on port ${port} `);
});