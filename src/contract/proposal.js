const VALID_TOPICS = [
  'asset_issue',
]

async function validateAssetIssue(content) {
  if (!content || content.currency === undefined || content.amount === undefined) throw new Error('Invalid proposal content')
  if (!/^[A-Za-z]{1,16}.[A-Z]{3,6}$/.test(content.currency)) throw new Error('Invalid currency')
  app.validate('amount', String(content.amount))
}

async function isProposalApproved(pid, topic) {
  const proposal = await app.sdb.load('Proposal', pid)
  if (!proposal) throw new Error('Proposal not found')

  if (topic !== proposal.topic) {
    return false
  }

  if (proposal.activated) return false

  const votes = await app.sdb.findAll('ProposalVote', { condition: { pid } })
  let validVoteCount = 0
  for (const v of votes) {
    if (app.isCurrentBookkeeper(v.voter)) {
      validVoteCount++
    }
  }
  if (validVoteCount <= Math.ceil(101 * 0.51)) return false
  return true
}

async function issue(pid) {
  const proposal = await app.sdb.findOne('Proposal', { condition: { tid: pid } })
  if (!proposal) return null
  if (proposal.activated) return null
  // if (!isProposalApproved(pid, 'asset_issue')) return 'Proposal is not approved'
  const content = JSON.parse(proposal.content)
  const name = content.currency
  const amount = content.amount

  if (!/^[A-Za-z]{1,16}.[A-Z]{3,6}$/.test(name)) return 'Invalid currency'
  app.validate('amount', amount)
  app.sdb.lock(`uia.issue@${name}`)

  const asset = await app.sdb.load('Asset', name)
  if (!asset) return 'Asset not exists'
  if (asset.issuerId !== this.sender.address) return 'Permission denied'

  const quantity = app.util.bignumber(asset.quantity).plus(amount)
  if (quantity.gt(asset.maximum)) return 'Exceed issue limit'

  asset.quantity = quantity.toString(10)
  app.sdb.update('Asset', { quantity: asset.quantity }, { name })

  app.balances.increase(this.sender.address, name, amount)
  app.sdb.update('Proposal', { activated: 1 }, { tid: pid })
  return null
}

module.exports = {
  async propose(title, desc, topic, content, endHeight) {
    if (!/^[A-Za-z0-9_\-+!@$% ]{10,100}$/.test(title)) return 'Invalid proposal title'
    if (desc.length > 4096) return 'Invalid proposal description'
    if (VALID_TOPICS.indexOf(topic) === -1) return 'Invalid proposal topic'
    if (!Number.isInteger(endHeight) || endHeight < 0) return 'EndHeight should be positive integer'
    if (endHeight < this.block.height + 5760) return 'Invalid proposal finish date'

    if (topic === 'asset_issue') {
      await validateAssetIssue(content, this)
    }

    app.sdb.create('Proposal', {
      tid: this.trs.id,
      timestamp: this.trs.timestamp,
      title,
      desc,
      topic,
      content: JSON.stringify(content),
      activated: 0,
      height: this.block.height,
      endHeight,
      senderId: this.sender.address,
    })
    return null
  },

  async vote(pid) {
    if (!app.isCurrentBookkeeper(this.sender.address)) return 'Permission denied'
    const proposal = await app.sdb.findOne('Proposal', { condition: { tid: pid } })
    if (!proposal) return 'Proposal not found'
    // if (this.block.height - proposal.height > 8640 * 30) return 'Proposal expired'
    if (this.block.height - proposal.height > 5760 * 30) return 'Proposal expired'
    const exists = await app.sdb.exists('ProposalVote', { voter: this.sender.address, pid })
    if (exists) return 'Already voted'
    app.sdb.create('ProposalVote', {
      tid: this.trs.id,
      pid,
      voter: this.sender.address,
    })
    const isApproved = await isProposalApproved(pid, 'asset_issue')
    if (isApproved) {
      await issue(pid)
    }
    return null
  },

}
