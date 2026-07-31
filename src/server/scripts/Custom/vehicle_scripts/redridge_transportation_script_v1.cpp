#include "ScriptMgr.h"
#include "CombatAI.h"
#include "Creature.h"

class redridge_transportation_script_v1 : public CreatureScript
{
public:
    redridge_transportation_script_v1() : CreatureScript("redridge_transportation_script_v1") { }

    enum Texts
    {
        SAY_ARRIVAL = 0
    };

    struct redridge_transportation_script_v1AI : public VehicleAI
    {
        redridge_transportation_script_v1AI(Creature* creature) : VehicleAI(creature) { }

        void UpdateAI(uint32 diff) override
        {
            VehicleAI::UpdateAI(diff);

            bool const isMoving = !me->IsStopped();
            if (_wasMoving && !isMoving)
                Talk(SAY_ARRIVAL);

            _wasMoving = isMoving;
        }

    private:
        bool _wasMoving = false;
    };

    CreatureAI* GetAI(Creature* creature) const override
    {
        return new redridge_transportation_script_v1AI(creature);
    }
};

void AddSC_redridge_transportation_script_v1()
{
    new redridge_transportation_script_v1();
}
