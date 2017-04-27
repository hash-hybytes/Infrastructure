// This is intended to handle any sort of alerts or notifications that may
// result from deploying and maintaining the infrastructure, or from the apps
// and services that are deployed. It is subscribed to the main SNS topics that
// notifications are sent to, and includes logic to handle different types of
// messages in different ways. The result of this particular function is to
// forward messages to Slack. Other endpoints could be handled by other
// functions.
//
// There are three things that need to be determined independently to post a
// message: the destination channel, the webhook to use, and the message itself
//
// The following environment variables are required:
// - ASG_SLACK_WEBHOOK_URL
// - CW_SLACK_WEBHOOK_URL
// - PIPELINE_SLACK_WEBHOOK_URL
// - CODEBUILD_SLACK_WEBHOOK_URL
// - CFN_SLACK_WEBHOOK_URL
// - IKE_SLACK_WEBHOOK_URL

const url = require('url');
const https = require('https');

const APPROVED = 'Approved';
const REJECTED = 'Rejected';

const CODEPIPELINE_MANUAL_APPROVAL_CALLBACK = 'codepipeline-approval-action';

exports.handler = (event, context, callback) => {
    try {
        main(event, context, callback);
    } catch (e) {
        callback(e);
    }
};
//
function main(event, context, callback) {
    const message = messageForEvent(event);
    const webhook = webhookForEvent(event);

    Promise.all([message, webhook])
        .then(postMessage)
        .then(() => callback(null))
        .catch(e => callback(e));
}

////////////////////////////////////////////////////////////////////////////////
// MESSAGE /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

function messageForEvent(event) {
    return (new Promise((resolve, reject) => {
        resolve({
            channel: channelForEvent(event),
            attachments: attachmentsForEvent(event)
        });
    }));
}

// Which channel the message gets sent to is based on the type of message. Some
// events, like CI status, have their own SNS topic, while others use the
// generic topics like info, error, etc. The channel is always based on the
// topic the message was sent to, but several topics can be used for the same
// channel
function channelForEvent(event) {
    const topicArn = event.Records[0].Sns.TopicArn;

    if (topicArn.search('OpsFatal') !== -1) {
        return '#ops-fatal';
    } else if (topicArn.search('OpsError') !== -1) {
        return '#ops-error';
    } else if (topicArn.search('OpsWarn') !== -1) {
        return '#ops-warn';
    } else if (topicArn.search('OpsInfo') !== -1) {
        return '#ops-info';
    } else if (topicArn.search('OpsDebug') !== -1) {
        return '#ops-debug';
    } else if (topicArn.search('OpsStatus') !== -1) {
        return '#ops-status';
    } else if (topicArn.search('CiStatus') !== -1) {
        return '#ops-debug';
    } else {
        return '#ops-debug';
    }
}

function attachmentsForEvent(event) {
    const sns = event.Records[0].Sns;

    // First deal with events that can be routed without parsing the SNS message
    if (sns.TopicArn.search('CiStatus') !== -1) {
        return attachmentsForCiStatus(event);
    } else if (sns.Message.search(`StackId='arn:aws:cloudformation`) !== -1) {
        return attachmentForCloudFormation(event);
    } else {
        // Then try parsing the message as JSON
        try {
            let message = JSON.parse(sns.Message);

            if (message.hasOwnProperty('AlarmName')) {
                // CloudWatch Alarms
                return attachmentsForAlarm(event);
            } else if (message.hasOwnProperty('approval')) {
                // CodePipeline Approval actions
                return attachmentsForCodePipelineApproval(event);
            } else if (message.hasOwnProperty('AutoScalingGroupARN')) {
                return attachmentsForAutoScaling(event);
            } else {
                // Deal with JSON-formatted messages that we don't know what to
                // do with specifically
                return attachmentsForUnknown(event);
            }

        } catch (e) {
            // If JSON parsing fails the message may be a legacy format, and
            // can be handled here. Or it's an event we don't know how to handle
            return attachmentsForUnknown(event);
        }
    }
}

// CI STATUS ///////////////////////////////////////////////////////////////////

// CI Status message can be sent from several sources. The GitHub event handler
// will send messages after a build has started, and includes data about the
// GitHub event that triggered the build, and the build itself.
// eg { event: {...}, build: {...} }
function attachmentsForCiStatus(event) {
    // TODO This is only true for message sent by the GitHub Event Handler;
    // those sent by the CodeBuild Callback Handler will be different

    const data = JSON.parse(event.Records[0].Sns.Message);

    if (data.event && data.build) {
        return attachmentsForCiStart(data.event, data.build);
    } else {
        // return attachmentsForCiEnd(data.event, data.build);
    }

    return [
        {
            fallback: `A build has started`,
            color: 'warning',
            text: `Building <${buildUrl}|${repo}> with commit <${commitUrl}|${sha}>`,
            // author_name: alarm.AlarmName,
            // title: alarm.AlarmDescription,
            // text: alarm.NewStateReason,
            footer: region,
            ts: (Date.parse(build.startTime) / 1000 | 0)
        }
    ];
}

// Event here is the GitHub event, not the Lambda event
// Needs to handle master pushes and pull requests a bit differently
function attachmentsForCiStart(event, build) {
    const repo = event.repository.full_name;
    const sha = event.after || event.pull_request.head.sha;
    const sha7 = sha.substring(0, 7);
    const branch = event.pull_request ? event.pull_request.head.ref : event.ref.replace(/refs\/heads\//, '');

    const arn = build.arn;
    const region = arn.split(':')[3];
    const buildId = arn.split('/')[1];

    const commitUrl = `https://github.com/${repo}/commit/${sha7}`;
    const buildUrl = `https://${region}.console.aws.amazon.com/codebuild/home#/builds/${buildId}/view/new`;

    const attachment = {
        ts: (Date.parse(build.startTime) / 1000 | 0),
        footer: branch,
        color: 'warning',
        mrkdwn_in: ['text']
    }

    if (event.pull_request) {
        const pr = event.pull_request;

        attachment.fallback = `Building ${repo} #${pr.number} with commit ${sha7}`;
        attachment.title = `Building <${buildUrl}|${repo}> with commit <${commitUrl}|${sha7}>`;
        attachment.text = `<${pr.html_url}|#${pr.number}> ${pr.title} – ${pr.user.login}`;
    } else {
        attachment.fallback = `Building ${repo}:${branch} with commit ${sha7}`;
        attachment.title = `Building <${buildUrl}|${repo}:${branch}> with commit <${commitUrl}|${sha7}>`;

        const compareUrl = `https://github.com/${repo}/compare/${event.before}...${event.after}`;

        const text = [];
        text.push(`<${compareUrl}|${event.commits.length} new commits> pushed by ${event.pusher.name}`);

        event.commits.forEach(commit => {
            text.push(`<${commit.url}|\`${commit.id.substring(0, 7)}\`> ${commit.author.username}:${commit.message}`);
        });

        attachment.text = text.join('\n');;
    }

    return [attachment];
}

// CLOUDFORMATION //////////////////////////////////////////////////////////////

// TODO
function attachmentForCloudFormation(event) {
    return [
        {
            fallback: 'CloudFormation notification',
            title: 'CloudFormation notification',
            text:  event.Records[0].Sns.Message,
            footer: 'These need to be parsed better'
        }
    ];
}

// CLOUDWATCH ALARM ////////////////////////////////////////////////////////////

function attachmentsForAlarm(event) {
    const alarm = JSON.parse(event.Records[0].Sns.Message);

    return [
        {
            fallback: `${alarm.NewStateValue} – ${alarm.AlarmDescription}`,
            color: colorForAlarm(alarm),
            author_name: alarm.AlarmName,
            title: alarm.AlarmDescription,
            text: alarm.NewStateReason,
            footer: alarm.Region,
            ts: (Date.now() / 1000 | 0)
        }
    ];
}

function colorForAlarm(alarm) {
    switch (alarm.NewStateValuession) {
        case 'ALARM':
            return '#cc0000';
        case 'OK':
            return '#019933';
      default:
          return '#e07701';
    }
}

// AUTO SCALING ////////////////////////////////////////////////////////////////

function attachmentsForAutoScaling(event) {
    const scaling = JSON.parse(event.Records[0].Sns.Message);

    return [
        {
            fallback: scaling.Cause,
            color: colorForAutoScaling(scaling),
            author_name: scaling.AutoScalingGroupName,
            title: scaling.Event,
            text: scaling.Cause,
            footer: scaling.Details['Availability Zone'],
            ts: (Date.now() / 1000 | 0)
        }
    ];
}

function colorForAutoScaling(scaling) {
    if (scaling.Event.search('EC2_INSTANCE_TERMINATE') !== -1) {
        return '#FF8400';
    } else {
        return '#0099FF';
    }
}

// CODEPIPELINE ////////////////////////////////////////////////////////////////

function attachmentsForCodePipelineApproval(event) {
    const message = JSON.parse(event.Records[0].Sns.Message);

    // All the values the CodePipeline SDK needs to approve or reject a pending
    // approval get stuffed into the `callback_id` as serialized JSON.
    // pipelineName
    // stageName
    // actionName
    // token
    const params = {
        pipelineName: message.approval.pipelineName,
        stageName: message.approval.stageName,
        actionName: message.approval.actionName,
        token: message.approval.token
    };

    return [
        {
            fallback: `${message.approval.pipelineName} ${message.approval.stageName}: ${message.approval.actionName}`,
            color: '#FF8400',
            author_name: message.approval.pipelineName,
            author_link: message.consoleLink,
            title: `${message.approval.stageName}: ${message.approval.actionName}`,
            title_link: message.approval.approvalReviewLink,
            text: `Manual approval required to trigger *ExecuteChangeSet*`,
            footer: message.region,
            ts: (Date.now() / 1000 | 0),
            mrkdwn_in: ['text'],
            callback_id: CODEPIPELINE_MANUAL_APPROVAL_CALLBACK,
            actions: [
                {
                    type: 'button',
                    name: 'decision',
                    text: 'Reject',
                    value: JSON.stringify(Object.assign({value: REJECTED}, params))
                }, {
                    type: 'button',
                    style: 'primary',
                    name: 'decision',
                    text: 'Approve',
                    value: JSON.stringify(Object.assign({value: APPROVED}, params)),
                    confirm: {
                        title: 'Are you sure?',
                        text: 'This will initiate a production deploy',
                        ok_text: 'Yes',
                        dismiss_text: 'Abort'
                    }
                }
            ]
        }
    ];
}

// UNKNOWN /////////////////////////////////////////////////////////////////////

function attachmentsForUnknown(event) {
    return [
        {
            fallback: 'Message of unknown type',
            title: 'Message of unknown type',
            text:  event.Records[0].Sns.Message,
            footer: event.Records[0].Sns.TopicArn
        }
    ];
}

////////////////////////////////////////////////////////////////////////////////
// SENDER //////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

// The webhook used to post the message determines who in Slack it appears the
// post is coming from. In some cases the source of the post is determined by
// where the message was sent, like in the case of a CI status update. For a
// CloudWatch alarm, though, the source should always be the same, even though
// some posts are sent to Warn and others are sent to Fatal.
function webhookForEvent(event) {
  return (new Promise((resolve, reject) => {
      const sns = event.Records[0].Sns;

      // Some webhooks can be determined without trying to parse the message
      if (sns.TopicArn.search('CiStatus') !== -1) {
          resolve(process.env.CODEBUILD_SLACK_WEBHOOK_URL);
      } else if (sns.Subject === 'AWS CloudFormation Notification') {
          resolve(process.env.CFN_SLACK_WEBHOOK_URL);
      } else {
          // Most webhooks are determined by the contents of a JSON message
          try {
              let message = JSON.parse(sns.Message);

              if (message.hasOwnProperty('AutoScalingGroupARN')) {
                  resolve(process.env.ASG_SLACK_WEBHOOK_URL);
              } else if (message.hasOwnProperty('approval')) {
                  resolve(process.env.PIPELINE_SLACK_WEBHOOK_URL);
              } else if (message.hasOwnProperty('AlarmName')) {
                  resolve(process.env.CW_SLACK_WEBHOOK_URL);
              } else {
                  // This is a JSON message that we don't handle explicitly
                  resolve(process.env.IKE_SLACK_WEBHOOK_URL);
              }
          } catch (e) {
              // Some message don't use JSON, and have to be handled differently
              resolve(process.env.IKE_SLACK_WEBHOOK_URL);
          }
      }
  }));
}

////////////////////////////////////////////////////////////////////////////////
// SLACK API ///////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

function postMessage(inputs) {
    return (new Promise((resolve, reject) => {
        const message = inputs[0];
        const webhook = inputs[1];

        const json = JSON.stringify(message);

        // Setup request options
        const options = url.parse(webhook);
        options.method = 'POST';
        options.headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
        };

        let req = https.request(options, res => {
            res.setEncoding('utf8');

            let json = '';
            res.on('data', chunk => json += chunk);
            res.on('end', () => {
                if (res.statusCode < 500) {
                    resolve();
                } else {
                    reject(new Error('Server Error'));
                }
            });
        });

        // Generic request error handling
        req.on('error', e => reject(e));

        req.write(json);
        req.end();
    }));
}
