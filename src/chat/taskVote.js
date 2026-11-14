export class TaskVote {
  constructor({ now, rng, getOptions, addWinner, onChange, announce, canVote }) {
    Object.assign(this, { now, rng, getOptions, addWinner, onChange, announce, canVote });
    this.poll = null;
  }

  update(matchId, hasWinner, side) {
    if (this.poll && (this.poll.matchId !== matchId || this.poll.side !== side || hasWinner)) {
      this.poll = null;
      this.onChange();
    }
    if (!matchId || hasWinner) return;

    if (this.poll && this.now() >= this.poll.endsAt) {
      const { options, counts } = this.publicState();
      this.poll = null;
      this.onChange();
      const highest = Math.max(...counts);
      if (highest > 0) {
        const tied = options.filter((_, index) => counts[index] === highest);
        if (this.addWinner(tied[Math.floor(this.rng() * tied.length)])) return;
      }
    }
    if (this.poll) return;
    const options = this.getOptions();
    if (options.length !== 4) return;
    this.poll = { matchId, side, endsAt: this.now() + 30000, options, ballots: new Map() };
    this.onChange();
    this.announce(options);
  }

  vote(message) {
    const { text, user } = message;
    const choice = /^([1-4])$/.exec(String(text ?? '').trim());
    if (!choice) return false;
    if (!user || !this.poll || this.now() >= this.poll.endsAt || !this.canVote(message)) return true;
    const voter = user.toLowerCase();
    const index = Number(choice[1]) - 1;
    if (this.poll.ballots.get(voter) !== index) {
      this.poll.ballots.set(voter, index);
      this.onChange();
    }
    return true;
  }

  publicState() {
    if (!this.poll) return null;
    const { endsAt, options, ballots } = this.poll;
    const counts = [0, 0, 0, 0];
    for (const index of ballots.values()) counts[index]++;
    return { endsAt, options, counts };
  }
}
