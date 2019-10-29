import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

// Import other required libraries
import * as fs from 'fs';
import * as mime from 'mime';
import { tmpdir } from 'os';
import { join } from 'path';
import * as fse from 'fs-extra';
// Imports the Google Cloud client library
import TextToSpeech from '@google-cloud/text-to-speech';
const client = new TextToSpeech.TextToSpeechClient();
// setup connection to google cloud storage
import { Storage } from '@google-cloud/storage';
// import { Timestamp } from '@google-cloud/firestore';
const projectId = "docent-backend-systems-2"; // project id

const writeFilePromise = (file: any, data: any, option: any) => {
    return new Promise((resolve, reject) => {
        fs.writeFile(file, data, option, error => {
            if (error) reject(error);
            resolve("File created! Time for the next step!");
        });
    });
};

export const generateAndStoreAudioFile = functions.pubsub.topic('docent.text-to-speech.items').onPublish(async (message) => {

    /** getting pub/sub message
     *  */
    let languageCode = null, descriptionText = null, itemId: string = '', locationId: string = '';
    try {
        languageCode = message.attributes.languageCode;
        descriptionText = message.attributes.descriptionText;
        itemId = message.attributes.itemId;
        locationId = message.attributes.locationId;
    } catch (e) {
        console.error('PubSub message was not JSON', e);
    }

    /**
     * Generating and store audio file
     */

    // Creat temp directory
    const workingDir = join(tmpdir(), 'synthesized'); //  /tmp/synthesized
    const tmpFilePath = join(workingDir, 'output.mp3'); //  /tmp/synthesized/output.mp3
    await fse.ensureDir(workingDir); // Ensure temp directory exists
    // bucketPath setting: <locationId>/items/<languageCode>/audio/<itemId>.mp3
    const uploadTo = 'items' + '/' + languageCode + '/' + 'audio' + '/' + itemId + '.mp3';
    const fileMime = mime.getType(uploadTo); // const fileMime = mime.lookup(uploadTo);  ==> audio/mpeg

    // preparing bucket
    const gcs = new Storage();
    const docentBucket = gcs.bucket(locationId);
    docentBucket.setUserProject(projectId);

    let bucketExistFlag: boolean = true;
    await docentBucket.exists().then(function (data) {
        bucketExistFlag = data[0];
    });

    if (!bucketExistFlag) {
        await docentBucket.create();
    }

    /**
     * Generating audio file
     */
    let response: any = "";
    try {
        // Wavenet Api request
        const wavenet_voice_type = languageCode + '-Wavenet-A';
        const wavenet_request: any = {
            input: {
                text: descriptionText
            },
            // Select the language and SSML Voice Gender (optional)
            voice: {
                languageCode: languageCode,
                ssmlGender: 'FEMALE',
                name: wavenet_voice_type
            },
            // Select the type of audio encoding
            audioConfig: {
                audioEncoding: 'MP3',
                sampleRateHertz: 48000,
                effectsProfileId: ['handset-class-device']
            },
        };
        const responses = await client.synthesizeSpeech(wavenet_request);
        response = responses[0];
    } catch (error) {
        // Standard Api request
        const standard_voice_type = languageCode + '-Standard-A';
        const standard_request: any = {
            input: {
                text: descriptionText
            },
            // Select the language and SSML Voice Gender (optional)
            voice: {
                languageCode: languageCode,
                ssmlGender: 'FEMALE',
                name: standard_voice_type
            },
            // Select the type of audio encoding
            audioConfig: {
                audioEncoding: 'MP3',
                sampleRateHertz: 48000,
                effectsProfileId: ['handset-class-device']
            },
        };
        const responses = await client.synthesizeSpeech(standard_request);
        response = responses[0];
    }

    /**
     * Audio temp file generate and upload to bucket
     */
    await writeFilePromise(tmpFilePath, response.audioContent, 'binary')
        .then(() => {
            docentBucket.upload(tmpFilePath, {
                destination: uploadTo,
                public: true,
                metadata: { contentType: fileMime, cacheControl: "public, max-age=31536000" }
            }, function (err, file) {
                if (err) {
                    console.error(err);
                    return;
                }
            });
        })
        .then(() => {
            console.log('audio uploaded successfully');
            return null;
        })
        .catch((error) => { console.error("audio upload error: ", error) });

    /**
     * Make the bucket and its contents private, using force to suppress errors
     */
    const opts = {
        includeFiles: true,
        force: true
    };

    docentBucket.makePrivate(opts, function (errors, files) {
        if (errors) {
            console.error("Made private error: ", errors);
        } else {
            console.log("Made private successfully.: ", files);
        }
    });

    /**
     * Firestore database updating
     */
    // Get the `FieldValue` object
    const FieldValue = admin.firestore.FieldValue;
    // Update lastTextToSpeechDate and itemDescriptionAudioPath
    await db.collection("items").doc(itemId).update({
        // lastTextToSpeechDate: admin.firestore.Timestamp.fromDate(new Date('December 10, 1815'))
        lastTextToSpeechDate: FieldValue.serverTimestamp(),
        multimedia: {
            itemDescriptionAudioPath: locationId + uploadTo
        }
    }).then(function () {
        console.error("lastTextToSpeechDate updated!!!");
    });

});