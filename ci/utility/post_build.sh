#!/bin/bash
set -e
set -a

# Look for any Docker images labeled with "org.prx.spire.publish.ecr"
push_to_ecr() {
    echo ">>> Looking for publishable Docker images"
    image_ids=$(docker images --filter "label=org.prx.spire.publish.ecr" --format "{{.ID}}")

    if [ -z "$image_ids" ]; then
        echo "< No Docker images found. Set the org.prx.spire.publish.ecr LABEL in a Dockerfile to publish its image."
    else
        for image_id in $image_ids; do
            echo "> Publishing Docker image: $image_id..."

            label=$(docker inspect --format '{{ index .Config.Labels "org.prx.spire.publish.ecr"}}' "$image_id")

            echo "> Logging into ECR"
            $(aws ecr get-login --no-include-email --region $AWS_DEFAULT_REGION)
            echo "> Logged in to ECR"

            unsafe_ecr_repo_name="GitHub/${PRX_REPO}"
            # Do any transformations necessary to satisfy ECR naming requirements:
            # Start with letter, [a-z0-9-_/.] (maybe, docs are unclear)
            safe_ecr_repo_name=$(echo "$unsafe_ecr_repo_name" | tr '[:upper:]' '[:lower:]')

            # Need to allow errors temporarily to check if the repo exists
            set +e
            aws ecr describe-repositories --repository-names "$safe_ecr_repo_name" > /dev/null 2>&1
            if [ $? -eq 0 ]
            then
                echo "> ECR Repository already exists"
            else
                echo "> Creating ECR repository"
                aws ecr create-repository --repository-name "$safe_ecr_repo_name"
            fi
            set -e

            # Construct the image name with a tag
            ecr_image_name="${PRX_AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com/${safe_ecr_repo_name}:${PRX_COMMIT}"

            # Export a variable whose name is the LABEL from the Dockerfile,
            # and whose value is the full image name with tag
            # e.g., if there's a LABEL org.prx.spire.publish.docker="WEB_SERVER"
            # this would set WEB_SERVER=1234.dkr.ecr.us-eas-1.amazonaws.com...
            declare -x "$label"="$ecr_image_name"

            echo "> Pushing image $image_id to ECR $ecr_image_name"
            docker tag $image_id $ecr_image_name
            docker push $ecr_image_name
            echo "< Finished publishing Docker image"
        done
    fi
}

# Look for any Docker images labeled with "org.prx.app"
push_to_ecr_legacy() {
    echo ">>> Looking for publishable Docker images"
    image_id=$(docker images --filter "label=org.prx.app" --format "{{.ID}}" | head -n 1)

    if [ -z "$image_id" ]; then
        echo "< No Docker images found. Set the org.prx.app LABEL in a Dockerfile to publish its image."
    else
        echo "> Publishing Docker image: $image_id..."

        echo "> Logging into ECR"
        $(aws ecr get-login --no-include-email --region $AWS_DEFAULT_REGION)
        echo "> Logged in to ECR"

        unsafe_ecr_repo_name="GitHub/${PRX_REPO}"
        # Do any transformations necessary to satisfy ECR naming requirements:
        # Start with letter, [a-z0-9-_/.] (maybe, docs are unclear)
        safe_ecr_repo_name=$(echo "$unsafe_ecr_repo_name" | tr '[:upper:]' '[:lower:]')

        # Need to allow errors temporarily to check if the repo exists
        set +e
        aws ecr describe-repositories --repository-names "$safe_ecr_repo_name" > /dev/null 2>&1
        if [ $? -eq 0 ]
        then
            echo "> ECR Repository already exists"
        else
            echo "> Creating ECR repository"
            aws ecr create-repository --repository-name "$safe_ecr_repo_name"
        fi
        set -e

        # Construct the image name with a tag
        ecr_image_name="${PRX_AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com/${safe_ecr_repo_name}:${PRX_COMMIT}"
        export PRX_ECR_IMAGE="$ecr_image_name"

        echo "> Pushing image $image_id to ECR $ecr_image_name"
        docker tag $image_id $ecr_image_name
        docker push $ecr_image_name
        echo "< Finished publishing Docker image"
    fi
}

# If the buildspec provides an S3 object key for Lambda code, the built code
# from the CodeBuild needs to be pushed to that key in the standard Application
# Code bucket provided by the Storage stack.
push_to_s3_lambda() {
    echo ">>> Looking for publishable Lambda code"
    image_id=$(docker images --filter "label=org.prx.lambda" --format "{{.ID}}" | head -n 1)

    if [ -z "$image_id" ]; then
        echo "< No code found. Set the org.prx.lambda LABEL in a Dockerfile to publish Lambda code."
    else
        if [ -z "$PRX_APPLICATION_CODE_BUCKET" ]; then exit 1 "PRX_APPLICATION_CODE_BUCKET required for Lambda code push"; fi

        if [ -z "$PRX_LAMBDA_ARCHIVE_BUILD_PATH" ]; then export PRX_LAMBDA_ARCHIVE_BUILD_PATH="/.prxci/build.zip" ; fi

        echo "> Publishing Lambda code from Docker image:  $image_id"

        # Create a container from the image that was made during the build.
        # The code will be somewhere in that image as a ZIP file.
        container_id=$(docker create $image_id)

        # Copy the ZIP file out of the container into the local environment
        # in a file called: lambda-code.zip
        echo "> Copying Lambda code ZIP file from container"
        docker cp $container_id:$PRX_LAMBDA_ARCHIVE_BUILD_PATH lambda-code.zip

        cleaned=`docker rm $container_id`

        # Send lambda-code.zip to S3 as a new object (not a version)
        echo "> Sending Lambda code ZIP file to S3"
        key="GitHub/${PRX_REPO}/${PRX_COMMIT}.zip"
        export PRX_LAMBDA_CODE_CONFIG_VALUE="$key"
        aws s3api put-object --bucket $PRX_APPLICATION_CODE_BUCKET --key $key --acl private --body lambda-code.zip
        echo "< Finished publishing Lambda code"
    fi
}

#
push_to_s3_static() {
    echo ">>> Looking for publishable static site code"
    image_id=$(docker images --filter "label=org.prx.s3static" --format "{{.ID}}" | head -n 1)

    if [ -z "$image_id" ]; then
        echo "< No code found. Set the org.prx.s3static LABEL in a Dockerfile to publish static site code."
    else
        if [ -z "$PRX_APPLICATION_CODE_BUCKET" ]; then exit 1 "PRX_APPLICATION_CODE_BUCKET required for S3 static code push"; fi

        if [ -z "$PRX_S3_STATIC_ARCHIVE_BUILD_PATH" ]; then export PRX_S3_STATIC_ARCHIVE_BUILD_PATH="/.prxci/build.zip" ; fi

        echo "> Publishing static site code from Docker image: $image_id"

        # Create a container from the image that was made during the build.
        # The code will be somewhere in that image as a ZIP file.
        container_id=$(docker create $image_id)

        # Copy the ZIP file out of the container into the local environment
        # in a file called: static-site.zip
        echo "> Copying static site code ZIP file from containe"
        docker cp $container_id:$PRX_S3_STATIC_ARCHIVE_BUILD_PATH static-site.zip

        cleaned=`docker rm $container_id`

        # Send static-site.zip to S3 as a new object (not a version)
        echo "> Sending static site ZIP file to S3"
        key="GitHub/${PRX_REPO}/${PRX_COMMIT}.zip"
        export PRX_LAMBDA_CODE_CONFIG_VALUE="$key"
        aws s3api put-object --bucket $PRX_APPLICATION_CODE_BUCKET --key $key --acl private --body static-site.zip
        echo "< Finished publishing static site code"
    fi
}

init() {
    echo ">>>>> Running post_build script"

    ## Set by CodeBuild during the build
    if [ -z "$CODEBUILD_BUILD_SUCCEEDING" ]; then exit 1 "CODEBUILD_BUILD_SUCCEEDING required"; fi

    # Only do work if the build is succeeding to this point
    if [ $CODEBUILD_BUILD_SUCCEEDING -eq 0 ]
    then
        echo "< A previous CodeBuild phase did not succeed"
    else
        # Check for required environment variables.
        #### Set on the AWS::CodeBuild::Project in template.yml
        if [ -z "$PRX_AWS_ACCOUNT_ID" ]; then exit 1 "PRX_AWS_ACCOUNT_ID required"; fi
        #### Set from startBuild (in build-handler Lambda)
        if [ -z "$PRX_REPO" ]; then exit 1 "PRX_REPO required"; fi
        if [ -z "$PRX_COMMIT" ]; then exit 1 "PRX_COMMIT required"; fi

        # Handle code publish if enabled
        if [ "$PRX_CI_PUBLISH" = "true" ]
        then
            echo "> Publishing code"
            push_to_ecr
            push_to_ecr_legacy
            push_to_s3_lambda
            push_to_s3_static
        elif [ "$PRX_CI_PRERELEASE" = "true" ]
        then
            echo "> Pushing pre-release code"
            push_to_ecr
            push_to_ecr_legacy
            push_to_s3_lambda
            push_to_s3_static
        else
            echo "< Code publishing is not enabled for this build"
        fi
    fi
}

init
