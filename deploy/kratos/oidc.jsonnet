// Maps a Google or GitHub account to identity traits. Sign-up is off, so this only matters when an existing person
// links the account (account settings, or Kratos' account linking when the email matches).
local claims = std.extVar('claims');
{
  identity: {
    traits: {
      email: claims.email,
    },
  },
}
