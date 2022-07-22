const axios = require('axios');
const { existsSync } = require('fs');
const { mkdir, writeFile } = require('node:fs/promises');

const USERNAME = 'krzysztof.orkisz@softwareone.com';
const PASSWORD = process.env.DEVOPS_PAT;

const ORGANIZATION = 'softwareone-pc';
const PROJECT = 'PyraCloud';

function getBaseUrl() {
  return `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/`;
}

function getAxios() {
  return axios.create({
    baseURL: getBaseUrl(),
    auth: {
      username: USERNAME,
      password: PASSWORD
    },
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

async function getRepositories(includeHidden = false) {
  const url = `git/repositories?includeLinks=false&includeAllUrls=false&includeHidden=${includeHidden}&api-version=7.1-preview.1`;
  const response = await getAxios().get(url);
  return response.data;
}

async function getCommits(repositoryId, author) {
  const url = `git/repositories/${repositoryId}/commitsbatch?$top=${10e5}&api-version=7.1-preview.1`;
  const response = await getAxios().post(url, {
    author,
    fromDate: '2019-01-01'
  });
  return response.data;
}

function stringifyFormatted(obj, indent = 2) {
  return JSON.stringify(obj, null, indent);
}

function getCommitFilePath(repoName) {
  return `./out/commits/${repoName}.json`;
}

async function dumpCommitsFromAllRepositories() {
  if (!existsSync('./out/commits')) {
    await mkdir('./out/commits', { recursive: true });
  }

  const repositories = await getRepositories();
  for (const { name, id } of repositories.value.filter(({ isDisabled }) => !isDisabled)) {
    if (existsSync(getCommitFilePath(name)) || existsSync(getCommitFilePath(`@${name}`))) {
      console.log(`Dump for repository ${name} already exists, ommiting`);
      continue;
    }
    console.log(`Processing repository: ${name}`);
    let commitsData;
    try {
      commitsData = await getCommits(id, USERNAME);
    } catch (e) {
      if (e.response.status === 404) {
        console.warn(`Cannot query repository ${name} for commits - it does not exist`);
      } else {
        console.error(`Unknown error for repository ${name}`, e.message);
      }
      continue;
    }

    const filePath = commitsData.count ? getCommitFilePath(name) : getCommitFilePath(`@${name}`);

    await writeFile(filePath, stringifyFormatted(commitsData.value));
  }
}

async function getWorkItemsRelations() {
  const wiqlUrl = `wit/wiql?api-version=6.0`;

  const query = `select [System.Id], 
    [System.WorkItemType], 
    [System.Title]
 from WorkItemLinks where (Source.[System.TeamProject] = @project and Source.[System.WorkItemType] in ('User Story', 'Bug', 'Task')) and ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') and (Target.[System.TeamProject] = @project and Target.[System.WorkItemType] in ('User Story', 'Bug', 'Task') and Target.[Microsoft.VSTS.Common.ClosedDate] >= '2019-01-01T00:00:00.0000000' and (Target.[System.History] contains words 'Orkisz' or Target.[System.AssignedTo] = 'Krzysztof Orkisz <krzysztof.orkisz@softwareone.com>')) order by [Microsoft.VSTS.Common.ClosedDate] mode (Recursive, ReturnMatchingChildren)`

  const wiqlResponse = await getAxios().post(wiqlUrl, {
    query
  });

  return wiqlResponse.data.workItemRelations;
}

async function dumpWorkItemsByIds(workItemRelations) {
  const wiBatchUrl = `wit/workitemsbatch?api-version=7.1-preview.1`;

  const workItems = [];

  const workItemsIDs = [...new Set(workItemRelations.map(wir => wir.target.id))];

  for (const chunk of splitIntoChunks(workItemsIDs, 200)) {
    const wiBatchResponse = await getAxios().post(wiBatchUrl, {
      $expand: 'all',
      ids: chunk,
      // fields: [
      //   'System.Id',
      //   'System.Title',
      //   'System.WorkItemType',
      //   'System.AssignedTo',
      //   'System.State',
      //   'System.Tags',
      //   'System.IterationPath',
      //   'System.AreaPath',
      //   'System.CreatedDate',
      //   'System.CreatedBy',
      //   'Microsoft.VSTS.Scheduling.StoryPoints',
      //   'Microsoft.VSTS.Common.ClosedDate',
      //   'System.Description',
      //   'Microsoft.VSTS.TCM.ReproSteps',
      //   'Microsoft.VSTS.Common.AcceptanceCriteria'
      // ]
    });

    workItems.push(...wiBatchResponse.data.value)
  }

  const tree = [];
  for (const wiRelationItem of workItemRelations) {
    if (!wiRelationItem.source) {
      tree.push(processWorkItem(workItems.find(wi => wi.id === wiRelationItem.target.id)));
    } else {
      const treeItem = tree.find(ti => ti.id === wiRelationItem.source.id);
      treeItem.items = treeItem.items || [];
      treeItem.items.push(processWorkItem(workItems.find(wi => wi.id === wiRelationItem.target.id)));
    }
  }

  console.log('done');

  await writeFile('./out/wi.json', stringifyFormatted(tree));
}

function processWorkItem(wi) {
  return {
    ...wi,
    fields: Object.entries(wi.fields).reduce((acc, [key, value]) => {
      acc[key.replace('.', '_')] = value;
      return acc;
    }, {})
  }
}

async function dumpAllWorkItems() {
  if (existsSync('./out/wi.json')) {
    console.log('Work items already dumped');
    return;
  }
  console.log('Dumping work items');

  const relations = await getWorkItemsRelations();
  await dumpWorkItemsByIds(relations);
}

function* splitIntoChunks(array, size) {
  for (let i = 0; i < array.length; i += size) {
    yield array.slice(i, i + size);
  }
}

async function act() {
  await dumpCommitsFromAllRepositories();
  await dumpAllWorkItems();
}

act().catch(console.error);
