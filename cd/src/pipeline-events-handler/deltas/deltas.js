const getStackFamily = require('./stack-family');
const getChangeSetFamily = require('./change-set-family');
const deltaArrow = require('./delta-arrow');
const deltaValue = require('./delta-value');

/**
 * Returns a multi-line string describing the parameters that have changed
 * @param {ParameterDeltas} deltas
 * @returns {String}
 */
function parameterDeltasList(deltas) {
  if (!deltas.length) {
    return 'This change set contained no meaningful parameter deltas.';
  }

  // Text blocks within attachments have a 3000 character limit. If the text is
  // too large, try creating the list without links to reduce the size.
  const withLinks = deltas
    .map((d) => {
      const oldValue = deltaValue(d.parameter, d.stackValue);
      const arrow = deltaArrow(d);
      const newValue = deltaValue(d.parameter, d.changeSetValue);

      let label;

      if (
        [
          'infrastructure-cd-root-staging',
          'infrastructure-cd-root-production',
        ].includes(d.stackName)
      ) {
        // For root stack parameters, label with just the parameter name
        label = d.parameter;
      } else {
        // For nested stacks, try to extract some meaningful part of the stack
        // name that is useful to include
        const nickname = d.stackName.split('-').at(-2);
        label = `${nickname}::${d.parameter}`;
      }

      return `*${label}*: ${oldValue} ${arrow} ${newValue}`;
    })
    .join('\n');

  if (withLinks.length < 2900) {
    return withLinks;
  } else {
    return deltas
      .map((d) => {
        const oldValue = deltaValue(d.parameter, d.stackValue, true);
        const arrow = deltaArrow(d, true);
        const newValue = deltaValue(d.parameter, d.changeSetValue, true);

        let label;

        if (
          [
            'infrastructure-cd-root-staging',
            'infrastructure-cd-root-production',
          ].includes(d.stackName)
        ) {
          // For root stack parameters, label with just the parameter name
          label = d.parameter;
        } else {
          // For nested stacks, try to extract some meaningful part of the stack
          // name that is useful to include
          const nickname = d.stackName.split('-').at(-2);
          label = `${nickname}::${d.parameter}`;
        }

        return `*${label}*: ${oldValue} ${arrow} ${newValue}`;
      })
      .join('\n');
  }
}

module.exports = {
  async nestedParameterDeltaText(stackName, changeSetName) {
    let stackFamily = await getStackFamily(stackName);
    const changeSetFamily = await getChangeSetFamily(stackName, changeSetName);
    const changeSetFamilyStackIds = changeSetFamily.map((c) => c.StackId);

    // When there's only a single change set, it likely means that nested
    // change sets was disabled for the given change set. In these cases, only
    // the root stack's parameters should be included in the deltas, because
    // there won't be anything to compare the child stacks to, and all
    // parameters will look like they've changed.
    if (changeSetFamily.length === 1) {
      stackFamily = [stackFamily[0]];
    }

    /** @type {ParameterDeltas} */
    const deltas = [];

    // Iterate through all existing stack parameters and create a delta for
    // each one, which includes the current value.
    for (const stack of stackFamily) {
      // Not all nested stacks are guaranteed to be have a change set. If a
      // stack in the stack family does not have a corresponding change set,
      // and the deltas are determined strictly by finding matching values in
      // the stack and change set families, all parameters for that stack would
      // appear to be unmatched. So, if there is no corresponding change set
      // for a given stack, that stack's parameters should not be included in
      // the deltas. (If there is a change set with no corresponding stack,
      // those deltas *will* still be included below.)
      if (changeSetFamilyStackIds.includes(stack.StackId)) {
        for (const param of stack.Parameters || []) {
          deltas.push({
            stackName: stack.StackName,
            stackId: stack.StackId,
            parameter: param.ParameterKey,
            stackValue: param.ResolvedValue || param.ParameterValue,
            changeSetValue: null,
          });
        }
      }
    }

    // Iterate through all the change set parameters. If a delta already exists
    // for a given stack+parameter key, add the value from the change set to
    // that delta. If not, make a new delta.
    for (const changeSet of changeSetFamily) {
      for (const param of changeSet.Parameters || []) {
        const delta = deltas.find(
          (d) =>
            param.ParameterKey === d.parameter &&
            changeSet.StackName === d.stackName,
        );

        if (delta) {
          delta.changeSetValue = param.ResolvedValue || param.ParameterValue;
        } else {
          deltas.push({
            stackName: changeSet.StackName,
            stackId: changeSet.StackId,
            parameter: param.ParameterKey,
            stackValue: null,
            changeSetValue: param.ResolvedValue || param.ParameterValue,
          });
        }
      }
    }

    // Filter down to only deltas where the values are different
    const changeDeltas = deltas.filter(
      (d) => d.stackValue !== d.changeSetValue,
    );

    // When using nested change sets, not all parameters in nested stacks are
    // correctly resolved. Any parameter values that depend on a stack or
    // resource output will be included in the change set parameters with an
    // unresolved value that looks like "{{IntrinsicFunction:…". Unless or until
    // AWS makes nested change sets smarter, we have to just ignore these,
    // because there's no way to compare the actual existing value from the stack
    // to the hypothetical future value that will be resolved when the change set
    // executes.
    //
    // Any parameters effected by this limitation are filtered out.
    const cleanedDeltas = changeDeltas.filter(
      (d) => !(d.changeSetValue || '').match(/\{\{IntrinsicFunction\:/),
    );

    // Some additional parameters that don't make sense to display in Slack are
    // also filtered out.
    const allowedDeltas = cleanedDeltas.filter(
      (d) =>
        ![
          'PipelineExecutionNonce',
          'TemplateUrlBase',
          'TemplateUrlPrefix',
        ].includes(d.parameter),
    );

    console.log(JSON.stringify(allowedDeltas));
    return parameterDeltasList(allowedDeltas);
  },
};
