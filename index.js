require('dotenv').config();
const express = require('express');
const sqlite3 = require("sqlite3");
const axios = require("axios").default;
const { TwitterApi } = require('twitter-api-v2')
const userClient = new TwitterApi({
    appKey: 'process.env.X_CLIENT_ID',
    appSecret: 'process.env.X_CLIENT_SECRET',
    accessToken: 'process.env.X_ACCESS_TOKEN',
    accessSecret: 'process.env.X_ACCESS_SECRET',
});
const v2Client = userClient.v2;
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
                    if(checkin['shout']) {
                        post_msg = `I'm at ${checkin.venue.name} in ${checkin.venue.location.state} ${checkin.venue.location.city}\n${checkin.checkinShortUrl}\n\n${checkin.shout}`
                    } else {
                        post_msg = `I'm at ${checkin.venue.name} in ${checkin.venue.location.state} ${checkin.venue.location.city}\n${checkin.checkinShortUrl}`
                    }
                    if(checkin.photos.count > 0) {
                        let p_url = checkin.photos.items[0]
                        axios.get(`${p_url.prefix}original${p_url.suffix}`, {
                            'responseType': 'arraybuffer',
                            'headers': {
                              'Content-Type': 'image/png'
                            }
                        })
                        .then((response)=>{
                            console.log(`${p_url.prefix}original${p_url.suffix} Downloaded.`)
                        })
                    }
                    console.log(post_msg)
                    // v2Client.tweet(post_msg)
                    res.status(200).send('Webhook received successfully!');
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
                    const stmt = db.prepare("insert into members(id,fsq_token) values(?,?) on conflict(id) do update set fsq_token = excluded.fsq_token");
                    stmt.run(user_id, oauth_token, (err, result) => {
                        if (err) {
                            res.status(400).json({
                                "status": "error",
                                "message": err.message
                            });
                            return;
                        } else {
                            res.status(200).json({
                                "status": "OK",
                                "lastID": stmt.lastID
                            });
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
    // res.status(200).send('Webhook received successfully!');
})

app.get('/xlogin', (req, res) => {

})

app.listen(port, () => {
    console.log(`Server is running on port ${port} `);
});