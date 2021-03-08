/**
 * This Lambda receives messages generated by a CodePipeline manual approval
 * action, via SNS. It sends a Slack message with information about the
 * pending approval along with actions (buttons) to take from within Slack
 * to approve or reject the release.
 */

/**
 * @typedef { import('aws-lambda').SNSEvent } SNSEvent
 * @typedef { import('@slack/web-api').ChatPostMessageArguments } ChatPostMessageArguments
 */

/**
 * Custom data configured on the pipeline manual approval action as JSON
 * @typedef {Object} CodePipelineApprovalCustomData
 * @property {String} StackName
 * @property {String} ChangeSetName
 * @property {String} AccountId
 */

/**
 * CodePipeline manual approval metadata
 * @typedef {Object} CodePipelineApproval
 * @property {String} pipelineName
 * @property {String} stageName
 * @property {String} actionName
 * @property {String} token
 * @property {String} expires - e.g., 2016-07-07T20:22Z
 * @property {String} [externalEntityLink]
 * @property {String} approvalReviewLink
 * @property {String} customData - JSON data configured on the pipeline action
 */

/**
 * The payload develired as JSON data via SNS from a CodePipeline manual
 * approval action
 * @typedef {Object} CodePipelineApprovalNotification
 * @property {String} region
 * @property {String} consoleLink
 * @property {CodePipelineApproval} approval
 */

/**
 * A tuple containing a paremeter key and the old and new value for the
 * parameter
 * @typedef {[AWS.CloudFormation.ParameterKey, AWS.CloudFormation.ParameterValue|undefined, AWS.CloudFormation.ParameterValue|undefined]} ParameterDelta
 */

/**
 * An array of parameter deltas
 * @typedef {ParameterDelta[]} ParameterDeltas
 */

const AWS = require('aws-sdk');

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const cloudformation = new AWS.CloudFormation({ apiVersion: '2010-05-15' });

/**
 * Returns all parameters that are the same between the stack and change set
 * @param {AWS.CloudFormation.Parameters} stackParameters
 * @param {AWS.CloudFormation.Parameters} changeSetParameters
 * @returns {AWS.CloudFormation.Parameters}
 */
function unchangedParameters(stackParameters, changeSetParameters) {
  return stackParameters.filter((p) => {
    return changeSetParameters.find(
      (s) =>
        s.ParameterKey === p.ParameterKey &&
        s.ParameterValue === p.ParameterValue,
    );
  });
}

/**
 * Returns all unique parameters present in either the stack parameters or the
 * change set parameters
 * @param {AWS.CloudFormation.Parameters} stackParameters
 * @param {AWS.CloudFormation.Parameters} changeSetParameters
 * @returns {AWS.CloudFormation.ParameterKey[]}
 */
function allParameterKeys(stackParameters, changeSetParameters) {
  return [
    ...new Set([
      ...stackParameters.map((p) => p.ParameterKey),
      ...changeSetParameters.map((p) => p.ParameterKey),
    ]),
  ];
}

/**
 * Returns the parameter deltas comparing the stack and change set parameters
 * in the form [parameter key, stack value, change set value]. If the parameter
 * is missing from the stack or change set, the value will be undefined.
 * @param {AWS.CloudFormation.Parameters} stackParameters
 * @param {AWS.CloudFormation.Parameters} changeSetParameters
 * @returns {ParameterDeltas}
 */
function parameterDeltas(stackParameters, changeSetParameters) {
  return allParameterKeys(stackParameters, changeSetParameters)
    .map((k) => {
      /** @type {ParameterDelta} */
      const delta = [
        k,
        stackParameters.find((p) => p.ParameterKey === k)?.ParameterValue,
        changeSetParameters.find((p) => p.ParameterKey === k)?.ParameterValue,
      ];
      return delta;
    })
    .filter((d) => d[1] !== d[2]);
}

/**
 * Builds a Slack markdown flavored string representing a specific parameter
 * value, based on the type of parameter (Git commit, Docker tag, etc)
 * @param {AWS.CloudFormation.ParameterKey} key
 * @param {AWS.CloudFormation.ParameterValue} value
 * @returns {String}
 */
function parameterDeltasListValue(key, value) {
  if (!value) {
    return;
  }

  if (key === 'InfrastructureGitCommit') {
    const url = `https://github.com/PRX/Infrastructure/commit/${value}`;
    return `\`<${url}|${value.slice(0, 6)}>\``;
  }

  if (/EcrImageTag/.test(key)) {
    const slug = key.replace('EcrImageTag', '');
    const url = `https://github.com/PRX/${slug}.prx.org/commit/${value}`;
    return `\`<${url}|${value}>\``;
  }

  return `\`${value}\``;
}

/**
 * Returns an arrow emoji for use when listed parameter changes. The arrow may
 * behave differently depending on the type of parameter it is representing
 * @param {ParameterDelta} parameterDelta
 * @returns {String}
 */
function parameterDeltasListArrow(parameterDelta) {
  if (parameterDelta[0] === 'InfrastructureGitCommit') {
    const url = `https://github.com/PRX/Infrastructure/compare/${parameterDelta[1]}...${parameterDelta[2]}`;
    return `<${url}|➡>`;
  }

  if (/EcrImageTag/.test(parameterDelta[0])) {
    const url = `https://github.com/PRX/Infrastructure/compare/${parameterDelta[1]}...${parameterDelta[2]}`;
    return `<${url}|➡>`;
  }

  return '➡';
}

/**
 * Returns a multi-line string describing the parameters that have changed
 * between a given stack and change set
 * @param {AWS.CloudFormation.Parameters} stackParameters
 * @param {AWS.CloudFormation.Parameters} changeSetParameters
 * @returns {String}
 */
function parameterDeltasList(stackParameters, changeSetParameters) {
  return parameterDeltas(stackParameters, changeSetParameters)
    .filter((d) => d[0] !== 'PipelineExecutionNonce')
    .map((d) => {
      const oldValue = parameterDeltasListValue(d[0], d[1]) || '❔';
      const newValue = parameterDeltasListValue(d[0], d[2]) || '❌';
      const arrow = parameterDeltasListArrow(d);

      return `*${d[0]}*: ${oldValue} ${arrow} ${newValue}`;
    })
    .join('\n');
}

/**
 * Constructs a Slack message payload with information about stack parameter
 * changes, and interactive buttons to approve or reject a deploy
 * @param {CodePipelineApprovalNotification} approvalNotification
 * @returns {Promise<ChatPostMessageArguments>}
 */
async function buildMessage(approvalNotification) {
  const { approval } = approvalNotification;

  /** @type {CodePipelineApprovalCustomData} */
  const customData = JSON.parse(approval.customData);
  const { StackName, ChangeSetName, AccountId } = customData;

  const stacks = await cloudformation.describeStacks({ StackName }).promise();
  const stack = stacks.Stacks[0];

  const changeSet = await cloudformation
    .describeChangeSet({ StackName, ChangeSetName })
    .promise();

  // A bunch of values that will be required to fulfill the action are stuffed
  // into the actions' values as JSON. This object should match the parameters
  // for codepipeline.putApprovalResult().
  /** @type {AWS.CodePipeline.PutApprovalResultInput} */
  const approvalParams = {
    pipelineName: approval.pipelineName,
    stageName: approval.stageName,
    actionName: approval.actionName,
    token: approval.token,
    result: {
      status: '',
      summary: '',
    },
  };

  // The summary gets overridden before the approval result is sent, so this
  // is just a convenient place to pass some extra values, albeit a bit
  // hacky
  const summaryData = `${approvalNotification.region},${AccountId}`;

  // These get Object.assigned below to the approvalParams
  /** @type {AWS.CodePipeline.ApprovalResult} */
  const approvedResult = { status: 'Approved', summary: summaryData };
  /** @type {AWS.CodePipeline.ApprovalResult} */
  const rejectedResult = { status: 'Rejected', summary: summaryData };

  const pipelineUrl = `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${approval.pipelineName}/view?region=${approvalNotification.region}`;

  return {
    username: 'AWS CodePipeline',
    icon_emoji: ':ops-codepipeline:',
    channel: '#ops-deploys',
    text: `The \`${approval.pipelineName}\` pipeline's *Production* stage is awaiting manual approval.`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Production deploy',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `The \`<${pipelineUrl}|${approval.pipelineName}>\` pipeline's *${approval.stageName}* stage is awaiting manual approval.`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            'CloudFormation stack parameter changes:',
            parameterDeltasList(stack.Parameters, changeSet.Parameters),
          ].join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Excludes ${
              unchangedParameters(stack.Parameters, changeSet.Parameters).length
            } unchanged parameters`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve',
              emoji: true,
            },
            style: 'primary',
            value: JSON.stringify(
              Object.assign(approvalParams, { result: approvedResult }),
            ),
            action_id: 'codepipeline-approval_approve-deploy',
            confirm: {
              title: {
                type: 'plain_text',
                text: 'Production Deploy Approval',
              },
              text: {
                type: 'mrkdwn',
                text:
                  'Are you sure you want to approve this CloudFormation change set for the production stack? Approval will trigger an immediate update to the production stack!',
              },
              confirm: {
                type: 'plain_text',
                text: 'Approve',
              },
              deny: {
                type: 'plain_text',
                text: 'Cancel',
              },
            },
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve with notes',
              emoji: true,
            },
            value: JSON.stringify(
              Object.assign(approvalParams, { result: approvedResult }),
            ),
            action_id: 'codepipeline-approval_annotate-deploy',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Reject',
              emoji: true,
            },
            style: 'danger',
            value: JSON.stringify(
              Object.assign(approvalParams, { result: rejectedResult }),
            ),
            action_id: 'codepipeline-approval_reject-deploy',
          },
        ],
      },
    ],
  };
}

/**
 * Publishes a Slack message to the relay SNS topic with information about a
 * pending CodePipeline deploy action, with interactive buttons to approve or
 * reject the deploy.
 * @param {SNSEvent} event
 * @returns {Promise<void>}
 */
exports.handler = async (event) => {
  console.log(JSON.stringify(event));

  /** @type {CodePipelineApprovalNotification} */
  const approvalNotification = JSON.parse(event.Records[0].Sns.Message);

  const slackMessage = await buildMessage(approvalNotification);

  await sns
    .publish({
      TopicArn: process.env.SLACK_MESSAGE_RELAY_TOPIC_ARN,
      Message: JSON.stringify(slackMessage),
    })
    .promise();
};
