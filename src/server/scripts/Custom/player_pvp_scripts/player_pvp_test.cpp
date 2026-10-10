#include "ScriptMgr.h"
#include "Player.h"
#include "Chat.h"

class player_pvp_test : public PlayerScript
{
public:
    player_pvp_test() : PlayerScript("player_pvp_test") {}

    void OnPVPKill(Player* killer, Player* killed) override
    {
        // Send a message to the server
        // telling everyone that the killer
        // has killed the killed player.
        if (killer && killer->GetSession())
        {
            ChatHandler(killer->GetSession()).PSendSysMessage("You have killed {}", killed->GetName());
        }
    }

};

void AddSC_player_pvp_test()
{
    new player_pvp_test();
}
